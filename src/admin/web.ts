// Web admin UI listener. Reachable only through Traefik + Authelia: identity headers are
// trusted solely from a peer in TRUSTED_PROXY that also presents the Traefik-injected
// X-SB-Admin-Proxy secret, the user must be in ADMIN_GROUP, and every POST needs a
// same-host Origin/Referer, a session-bound HMAC CSRF token and a one-time form nonce.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import { db } from "../db";
import { countActiveTokens, createToken, listTokens, revokeToken, TokenValidationError, validateTokenInput } from "../auth/tokens";
import { AGENT_PRESET, confirmableWildcards, dropRedundantScopes, formatScope, parseScopes, PRESETS, resolveScopes, wildcardWarnings } from "../cli/token";
import type { Scope } from "../auth/types";
import { dbOk, getBootInfo, vaultOk } from "../health";
import { isValidInboxId, listInboxIds } from "../inbox";
import { errorMessage, safeAudit } from "../tools/common";
import { UnsafePathError } from "../vault/paths";
import { getSyncStatus, redact, refreshConflictBranches } from "../vault/git";
import { listen } from "../listen";
import type { Lifecycle, TrustedProxy } from "../server";
import type { SafeHtml } from "../web/html";
import { CSS, JS } from "../web/assets";
import {
  Banner,
  Ctx,
  DashboardData,
  dashboardView,
  errorView,
  inboxView,
  proposalView,
  tokenCreatedView,
  tokensView,
  TokenForm,
} from "../web/views";
import { OneTimeStore } from "./onetime";
import { acceptProposal, AdminError, listInbox, rejectProposal, showProposal } from "./service";
import { vaultRouter } from "./vaultRoutes";
import { queryAudit } from "../audit";
import { auditView } from "../web/auditView";

export const DEFAULT_WEB_PORT = 3002;
export const DEFAULT_ADMIN_GROUP = "admins";

export function webPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ADMIN_WEB_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_WEB_PORT;
}

export interface WebAdminOptions {
  vaultRoot: string;
  trustedProxy: TrustedProxy;
  lifecycle?: Lifecycle;
  adminGroup?: string;
  secret?: string;
  // Shared secret Traefik injects (X-SB-Admin-Proxy) after Authelia; required, >= 32 chars.
  proxySecret: string;
  sessionCookie?: string;
}

export const MIN_PROXY_SECRET = 32;
export const PROXY_HEADER = "x-sb-admin-proxy";
export const DEFAULT_SESSION_COOKIE = "authelia_session";

const BUCKET_MS = 4 * 3_600_000;
const DAY_MS = 86_400_000;
const FLASH_TTL_MS = 5 * 60_000;
const NONCE_TTL_MS = 30 * 60_000;

const sha256 = (v: string): Buffer => createHash("sha256").update(v).digest();

// Constant-time string compare (digests first, so lengths do not leak).
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

// ---- CSRF ------------------------------------------------------------------

// Bound to the user and to the Authelia session cookie: a new login invalidates old tokens.
export function csrfToken(secret: string, user: string, session: string, now = Date.now()): string {
  return createHmac("sha256", secret)
    .update(`${user}\0${sha256(session).toString("hex")}\0${Math.floor(now / BUCKET_MS)}`)
    .digest("hex");
}

// Accepts the current and the previous 4-hour bucket.
export function csrfValid(secret: string, user: string, session: string, given: unknown, now = Date.now()): boolean {
  if (!session || typeof given !== "string" || given.length !== 64) return false;
  return [now, now - BUCKET_MS].some((t) => safeEqual(csrfToken(secret, user, session, t), given));
}

function cookieValue(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function sameOrigin(req: Request): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const src = req.headers.origin ?? req.headers.referer;
  if (typeof src !== "string") return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

// ---- helpers ---------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLASH_RE = /^[0-9a-f]{32}$/;

type Flash =
  | { kind: "banner"; banner: Banner }
  | { kind: "token"; created: { id: string; name: string; token: string; expires_at: string | null }; notes: string[] };

async function dashboardData(vaultRoot: string): Promise<DashboardData> {
  const vault = vaultOk(vaultRoot);
  const info = await getBootInfo(vaultRoot);
  if (vault) await refreshConflictBranches(vaultRoot);
  const sync = getSyncStatus(vaultRoot);
  const since = new Date(Date.now() - DAY_MS).toISOString();
  // A broken DB must not take the dashboard down: failed counts show as n/a.
  const safeCount = (fn: () => number): number | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const count = (sql: string, ...args: unknown[]): number | null => {
    try {
      return (db.prepare(sql).get(...args) as { n: number }).n;
    } catch {
      return null;
    }
  };
  let pending: number | null = null;
  try {
    pending = (await listInboxIds(vaultRoot)).length;
  } catch {
    /* unsafe or unreadable inbox dir: n/a */
  }
  return {
    dbOk: dbOk(),
    vaultOk: vault,
    hasRemote: info?.hasRemote ?? false,
    branch: info?.branch || null,
    unpushed: sync.unpushed,
    lastPushOk: sync.lastPushOk,
    lastPushAt: sync.lastPushAt,
    lastError: sync.lastError ? `${sync.lastError.kind} at ${sync.lastError.at}` : null,
    conflictBranches: sync.conflictBranches,
    activeTokens: safeCount(countActiveTokens),
    pendingProposals: pending,
    audit24h: count("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ?", since),
  };
}

// Scope lines from the textarea: one space:project:section:permission per line.
function scopesFromText(text: string): Scope[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => parseScopes(l));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- app -------------------------------------------------------------------

export function createWebAdminApp(opts: WebAdminOptions): Express {
  const { vaultRoot, trustedProxy, lifecycle, proxySecret } = opts;
  if (typeof proxySecret !== "string" || proxySecret.length < MIN_PROXY_SECRET) {
    throw new Error(`ADMIN_PROXY_SECRET must be at least ${MIN_PROXY_SECRET} characters`);
  }
  const adminGroup = opts.adminGroup || DEFAULT_ADMIN_GROUP;
  const sessionCookie = opts.sessionCookie || DEFAULT_SESSION_COOKIE;
  // Without ADMIN_WEB_SECRET the tokens reset on restart (forms must be reloaded).
  const secret = opts.secret || randomBytes(32).toString("hex");
  const flash = new OneTimeStore<Flash>(FLASH_TTL_MS, 200);
  const nonces = new OneTimeStore<true>(NONCE_TTL_MS, 5000);

  const app = express();
  app.disable("x-powered-by");

  // Tracked like /mcp requests so shutdown waits for them; new ones refused once it began.
  app.use((_req, res, next) => {
    if (lifecycle) {
      if (lifecycle.shuttingDown) {
        res.setHeader("Connection", "close");
        res.status(503).type("text/plain").send("server is shutting down");
        return;
      }
      lifecycle.enter(res);
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Identity: the direct peer must be a trusted proxy AND carry the secret Traefik injects
  // after Authelia; only then are the Remote-* headers believed.
  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress;
    const proxyHeader = req.headers[PROXY_HEADER];
    if (!peer || !trustedProxy.trust(peer) || typeof proxyHeader !== "string" || !safeEqual(proxyHeader, proxySecret)) {
      res.status(401).type("text/plain").send("unauthorized");
      return;
    }
    const user = req.headers["remote-user"];
    if (typeof user !== "string" || user.length < 1 || user.length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(user)) {
      res.status(401).type("text/plain").send("unauthorized");
      return;
    }
    const groups = String(req.headers["remote-groups"] ?? "")
      .split(",")
      .map((g) => g.trim());
    if (!groups.includes(adminGroup)) {
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    res.locals.user = user;
    res.locals.actor = `admin:${user}`;
    res.locals.session = cookieValue(req, sessionCookie);
    next();
  });

  const userOf = (res: Response): string => res.locals.user as string;
  const ctxOf = (res: Response): Ctx => {
    const user = userOf(res);
    return { user, csrf: csrfToken(secret, user, res.locals.session as string), nonce: () => nonces.put(true, user) };
  };
  const send = (res: Response, view: SafeHtml, status = 200): void => void res.status(status).type("html").send(view.value);

  // Post-Redirect-Get: the outcome lives in a one-time flash shown once on the target page.
  const redirectWithFlash = (res: Response, to: string, value: Flash): void => {
    res.redirect(303, `${to}${to.includes("?") ? "&" : "?"}flash=${flash.put(value, userOf(res))}`);
  };
  const takeBanner = (req: Request, res: Response): Banner | undefined => {
    const f = FLASH_RE.test(str(req.query.flash)) ? flash.take(req.query.flash, userOf(res)) : undefined;
    return f?.kind === "banner" ? f.banner : undefined;
  };

  app.get("/static/style.css", (_req, res) => void res.type("text/css").send(CSS));
  app.get("/static/app.js", (_req, res) => void res.type("application/javascript").send(JS));

  // State-changing requests: same-host Origin/Referer, session-bound CSRF token, then a
  // one-time form nonce (a replayed or duplicate POST is refused).
  // /vault carries whole notes (cap 512K chars, up to 3 bytes/char once percent-encoded).
  const smallForm = express.urlencoded({ extended: false, limit: "32kb" });
  const noteForm = express.urlencoded({ extended: false, limit: "8mb" });
  app.use((req, res, next) => (req.path.startsWith("/vault/") ? noteForm : smallForm)(req, res, next));
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.method !== "POST") return void res.status(405).type("text/plain").send("method not allowed");
    if (!sameOrigin(req)) return void res.status(403).type("text/plain").send("forbidden: cross-origin request");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!csrfValid(secret, userOf(res), res.locals.session as string, body.csrf)) {
      return void res.status(403).type("text/plain").send("forbidden: invalid or missing CSRF token (reload the page)");
    }
    if (!nonces.take(body.nonce, userOf(res))) {
      return void send(res, errorView(ctxOf(res), 409, "This form was already submitted (or has expired). Reload the page and try again."), 409);
    }
    next();
  });

  app.get("/", async (_req, res, next) => {
    try {
      send(res, dashboardView(ctxOf(res), await dashboardData(vaultRoot)));
    } catch (err) {
      next(err);
    }
  });

  const auditAdmin = (res: Response, action: string, result: "ok" | "error", detail: string): void => {
    const actor = res.locals.actor as string;
    safeAudit({ tokenId: actor, tokenName: actor, action, result, detail }, actor);
  };

  // ---- tokens ----

  const tokensRouter = express.Router();
  tokensRouter.param("id", (_req, res, next, id: string) => {
    if (!UUID_RE.test(id)) return void send(res, errorView(ctxOf(res), 400, "invalid token id"), 400);
    next();
  });

  tokensRouter.get("/", (req, res) => send(res, tokensView(ctxOf(res), listTokens(), takeBanner(req, res))));

  // The plaintext is reachable only through this one-time flash, never rendered by the POST.
  tokensRouter.get("/created/:flashId", (req, res) => {
    const fid = req.params.flashId as string;
    const f = FLASH_RE.test(fid) ? flash.take(fid, userOf(res)) : undefined;
    if (f?.kind !== "token") {
      const msg = "This page was already shown or has expired. A token cannot be retrieved again; revoke it and create a new one if it was lost.";
      return void send(res, errorView(ctxOf(res), 404, msg), 404);
    }
    send(res, tokenCreatedView(ctxOf(res), f.created, f.notes));
  });

  tokensRouter.post("/", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const form: TokenForm = {
      name: str(body.name),
      scopes: str(body.scopes),
      preset: str(body.preset),
      allowWildcard: body.allow_wildcard === "1",
      expiresInDays: str(body.expires_in_days).trim(),
    };
    const fail = (title: string, lines: string[] = []): void =>
      send(res, tokensView(ctxOf(res), listTokens(), { kind: "err", title, lines }, form), 422);
    try {
      let scopes: Scope[];
      if (form.preset && form.preset !== AGENT_PRESET && form.scopes.trim()) return fail("Use either a preset or explicit scopes, not both.");
      if (form.preset === AGENT_PRESET) {
        scopes = resolveScopes(form.preset, undefined, form.name.trim());
        if (form.scopes.trim()) scopes.push(...scopesFromText(form.scopes));
      } else if (form.preset) {
        if (!Object.hasOwn(PRESETS, form.preset)) return fail(`Unknown preset "${form.preset}".`);
        scopes = PRESETS[form.preset].map((s) => ({ ...s }));
      } else {
        if (!form.scopes.trim()) return fail("Choose a preset or enter at least one scope.");
        scopes = scopesFromText(form.scopes);
      }
      const validated = validateTokenInput(form.name, scopes);
      const { kept, dropped } = dropRedundantScopes(validated.scopes);
      const warnings = wildcardWarnings(confirmableWildcards(kept, form.preset, validated.name));
      if (warnings.length > 0 && !form.allowWildcard) {
        return fail("Wildcard scopes and presets grant broad access. Tick \"Allow wildcard\" to confirm. No token created.", warnings);
      }
      let expiresInDays: number | undefined;
      if (form.expiresInDays) {
        if (!/^\d{1,4}$/.test(form.expiresInDays)) return fail("Expires in (days) must be an integer between 1 and 3650.");
        expiresInDays = Number(form.expiresInDays);
      }
      const created = createToken(validated.name, kept, { expiresInDays });
      const notes = [
        ...warnings,
        ...dropped.map((s) => `Dropped redundant scope ${formatScope(s)} (already covered by a wildcard scope).`),
      ];
      // Flash first: nothing after the token exists may lose the one chance to show it.
      const to = `/tokens/created/${flash.put({ kind: "token", created: { id: created.id, name: created.name, token: created.token, expires_at: created.expires_at ?? null }, notes }, userOf(res))}`;
      auditAdmin(res, "admin_token_create", "ok", `${created.id} ${created.name} [${kept.map(formatScope).join(",")}]`);
      res.redirect(303, to);
    } catch (err) {
      if (err instanceof TokenValidationError || (err instanceof Error && /^invalid scope/.test(err.message))) {
        return fail(err.message);
      }
      throw err;
    }
  });

  tokensRouter.post("/:id/revoke", (req, res) => {
    const id = req.params.id as string;
    let banner: Banner;
    if (revokeToken(id)) {
      auditAdmin(res, "admin_token_revoke", "ok", id);
      banner = { kind: "ok", title: `Token ${id} revoked.` };
    } else {
      auditAdmin(res, "admin_token_revoke", "error", `${id} not found or already revoked`);
      banner = { kind: "err", title: "Token not found or already revoked." };
    }
    redirectWithFlash(res, "/tokens", { kind: "banner", banner });
  });
  app.use("/tokens", tokensRouter);

  // ---- inbox ----

  const inboxRouter = express.Router();
  inboxRouter.param("id", (_req, res, next, id: string) => {
    if (!isValidInboxId(id)) return void send(res, errorView(ctxOf(res), 400, "invalid proposal id"), 400);
    next();
  });

  inboxRouter.get("/", async (req, res, next) => {
    try {
      const banner = takeBanner(req, res);
      send(res, inboxView(ctxOf(res), await listInbox(vaultRoot), banner));
    } catch (err) {
      next(err);
    }
  });

  inboxRouter.get("/:id", async (req, res, next) => {
    try {
      const banner = takeBanner(req, res);
      try {
        const p = await showProposal(vaultRoot, req.params.id as string);
        send(res, proposalView(ctxOf(res), p, req.query.view === "raw" ? "raw" : "rendered", banner));
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        send(res, errorView(ctxOf(res), err.status, err.message), err.status);
      }
    } catch (err) {
      next(err);
    }
  });

  // Runs the operation, then redirects with the outcome flash. The flash is set right after
  // the operation returns, before anything else that could fail.
  type Op = (id: string, body: Record<string, unknown>, actor: string) => Promise<{ target: string; commit: string | null }>;
  const resolveWith =
    (op: Op, verb: string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const id = req.params.id as string;
      try {
        try {
          const r = await op(id, req.body as Record<string, unknown>, res.locals.actor as string);
          redirectWithFlash(res, "/inbox", {
            kind: "banner",
            banner: { kind: "ok", title: `${verb} ${r.target}.`, lines: r.commit ? [`Commit ${r.commit}`] : [] },
          });
        } catch (err) {
          if (!(err instanceof AdminError)) throw err;
          const to = err.status === 404 ? "/inbox" : `/inbox/${id}`;
          redirectWithFlash(res, to, { kind: "banner", banner: { kind: "err", title: err.message } });
        }
      } catch (err) {
        next(err);
      }
    };

  inboxRouter.post("/:id/accept", resolveWith((id, body, actor) => acceptProposal(vaultRoot, id, body.overwrite === "1", actor), "Accepted"));
  inboxRouter.post("/:id/reject", resolveWith((id, _body, actor) => rejectProposal(vaultRoot, id, actor), "Rejected"));
  app.use("/inbox", inboxRouter);

  // ---- vault browser / editor ----

  app.use(
    "/vault",
    vaultRouter({
      vaultRoot,
      ctxOf,
      send,
      takeBanner,
      redirectBanner: (res, to, banner) => redirectWithFlash(res, to, { kind: "banner", banner }),
    }),
  );

  // ---- audit log (read-only) ----

  const AUDIT_ACTION_RE = /^[a-z0-9_]{1,64}$/;
  const AUDIT_ID_RE = /^[1-9]\d{0,14}$/;
  app.get("/audit", (req, res) => {
    const bad = (m: string): void => send(res, errorView(ctxOf(res), 400, m), 400);
    // Empty form fields mean "no filter"; anything else must validate.
    const opt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    const before = opt(req.query.before);
    const token = opt(req.query.token);
    const action = opt(req.query.action);
    if (req.query.before !== undefined && typeof req.query.before !== "string") return bad("invalid filter");
    if (before !== undefined && !AUDIT_ID_RE.test(before)) return bad("invalid before id");
    if (action !== undefined && !AUDIT_ACTION_RE.test(action)) return bad("invalid action filter");
    if (token !== undefined && (token.length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(token))) return bad("invalid token filter");
    if (["token", "action"].some((k) => req.query[k] !== undefined && typeof req.query[k] !== "string")) return bad("invalid filter");
    const { rows, nextBefore } = queryAudit({ before: before === undefined ? undefined : Number(before), tokenName: token, action });
    send(res, auditView(ctxOf(res), rows, nextBefore, { token, action }));
  });

  app.use((_req, res) => void send(res, errorView(ctxOf(res), 404, "Page not found."), 404));
  // Never leak internals; the real reason goes to the log only.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`web admin error: ${redact(err instanceof UnsafePathError ? err.message : errorMessage(err))}`);
    if (res.headersSent) return;
    const e = err as { status?: number; type?: string };
    if (e.type === "entity.too.large") return void send(res, errorView(ctxOf(res), 413, "Request too large."), 413);
    send(res, errorView(ctxOf(res), 500, "Internal error."), 500);
  });
  return app;
}

// Binds all interfaces (Traefik reaches it over the overlay network); the peer check, the
// proxy secret and the group check above are what protect it. Refuses to start without
// TRUSTED_PROXY or a strong ADMIN_PROXY_SECRET.
export async function startWebAdmin(
  vaultRoot: string,
  lifecycle: Lifecycle | undefined,
  trustedProxy: TrustedProxy,
  env: NodeJS.ProcessEnv = process.env,
  port = webPort(env),
): Promise<Server | undefined> {
  if (!env.TRUSTED_PROXY?.trim()) {
    console.error("web admin disabled: TRUSTED_PROXY is not set (identity headers cannot be trusted without it)");
    return undefined;
  }
  const proxySecret = env.ADMIN_PROXY_SECRET ?? "";
  if (proxySecret.length < MIN_PROXY_SECRET) {
    console.error(`web admin disabled: ADMIN_PROXY_SECRET must be set (at least ${MIN_PROXY_SECRET} characters)`);
    return undefined;
  }
  try {
    const app = createWebAdminApp({
      vaultRoot,
      trustedProxy,
      lifecycle,
      adminGroup: env.ADMIN_GROUP || DEFAULT_ADMIN_GROUP,
      secret: env.ADMIN_WEB_SECRET || undefined,
      proxySecret,
      sessionCookie: env.AUTHELIA_SESSION_COOKIE || undefined,
    });
    const s = await listen(app, port);
    console.log(`web admin listening on port ${port} (behind Traefik + Authelia only)`);
    return s;
  } catch (err) {
    console.error(`web admin disabled, cannot listen on port ${port}: ${errorMessage(err)}`);
    return undefined;
  }
}
