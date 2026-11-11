// Web admin UI listener. Reachable only through Traefik + Authelia: identity headers are
// trusted solely from a peer in TRUSTED_PROXY, the user must be in ADMIN_GROUP, and every
// POST needs a same-host Origin/Referer plus an HMAC CSRF token.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { db } from "../db";
import { createToken, listTokens, revokeToken, TokenValidationError, validateTokenInput } from "../auth/tokens";
import { dropRedundantScopes, formatScope, parseScopes, PRESETS, wildcardWarnings } from "../cli/token";
import type { Scope } from "../auth/types";
import { isValidInboxId, listInboxIds } from "../inbox";
import { errorMessage, safeAudit } from "../tools/common";
import { UnsafePathError } from "../vault/paths";
import { getSyncStatus, hasRemote, redact, refreshConflictBranches, runGit } from "../vault/git";
import { listen } from "../listen";
import type { Lifecycle, TrustedProxy } from "../server";
import type { SafeHtml } from "../web/html";
import { CSS, JS } from "../web/assets";
import {
  Banner,
  Ctx,
  dashboardView,
  errorView,
  inboxView,
  proposalView,
  tokenCreatedView,
  tokensView,
  TokenForm,
} from "../web/views";
import { acceptProposal, AdminError, listInbox, rejectProposal, showProposal } from "./service";

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
}

const DAY_MS = 86_400_000;

// ---- CSRF ------------------------------------------------------------------

export function csrfToken(secret: string, user: string, now = Date.now()): string {
  return createHmac("sha256", secret).update(`${user}\0${Math.floor(now / DAY_MS)}`).digest("hex");
}

// Accepts the current and the previous day bucket (a form opened just before midnight).
export function csrfValid(secret: string, user: string, given: unknown, now = Date.now()): boolean {
  if (typeof given !== "string" || given.length !== 64) return false;
  return [now, now - DAY_MS].some((t) => {
    const want = Buffer.from(csrfToken(secret, user, t));
    const got = Buffer.from(given);
    return want.length === got.length && timingSafeEqual(want, got);
  });
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

function dbOk(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

async function dashboardData(vaultRoot: string): Promise<import("../web/views").DashboardData> {
  const vaultOk = existsSync(path.join(vaultRoot, ".git"));
  let remote = false;
  let branch: string | null = null;
  if (vaultOk) {
    try {
      remote = await hasRemote(vaultRoot);
    } catch {
      /* reported as none */
    }
    try {
      branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], vaultRoot)).trim() || null;
    } catch {
      /* no commits yet */
    }
    await refreshConflictBranches(vaultRoot);
  }
  const sync = getSyncStatus(vaultRoot);
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
  let pending = 0;
  try {
    pending = (await listInboxIds(vaultRoot)).length;
  } catch {
    /* unsafe or unreadable inbox dir: shown as 0 */
  }
  return {
    dbOk: dbOk(),
    vaultOk,
    hasRemote: remote,
    branch,
    unpushed: sync.unpushed,
    lastPushOk: sync.lastPushOk,
    lastPushAt: sync.lastPushAt,
    lastError: sync.lastError ? `${sync.lastError.kind} at ${sync.lastError.at}` : null,
    conflictBranches: sync.conflictBranches,
    activeTokens: count("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL"),
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
  const { vaultRoot, trustedProxy, lifecycle } = opts;
  const adminGroup = opts.adminGroup || DEFAULT_ADMIN_GROUP;
  // Without ADMIN_WEB_SECRET the tokens reset on restart (forms must be reloaded).
  const secret = opts.secret || randomBytes(32).toString("hex");

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

  // Identity: headers count only when the direct TCP peer is a trusted proxy.
  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress;
    if (!peer || !trustedProxy.trust(peer)) {
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
    next();
  });

  const ctxOf = (res: Response): Ctx => {
    const user = res.locals.user as string;
    return { user, csrf: csrfToken(secret, user) };
  };
  const send = (res: Response, view: SafeHtml, status = 200): void => void res.status(status).type("html").send(view.value);

  app.get("/static/style.css", (_req, res) => void res.type("text/css").send(CSS));
  app.get("/static/app.js", (_req, res) => void res.type("application/javascript").send(JS));

  // State-changing requests: same-host Origin/Referer, then the HMAC token.
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.method !== "POST") return void res.status(405).type("text/plain").send("method not allowed");
    if (!sameOrigin(req)) return void res.status(403).type("text/plain").send("forbidden: cross-origin request");
    if (!csrfValid(secret, res.locals.user as string, (req.body as Record<string, unknown> | undefined)?.csrf)) {
      return void res.status(403).type("text/plain").send("forbidden: invalid or missing CSRF token (reload the page)");
    }
    next();
  });

  app.param("id", (_req, res, next, id: string) => {
    if (!isValidInboxId(id) && !UUID_RE.test(id)) return void send(res, errorView(ctxOf(res), 400, "invalid id"), 400);
    next();
  });

  app.get("/", async (_req, res, next) => {
    try {
      send(res, dashboardView(ctxOf(res), await dashboardData(vaultRoot)));
    } catch (err) {
      next(err);
    }
  });

  // ---- tokens ----

  const auditAdmin = (res: Response, action: string, result: "ok" | "error", detail: string): void => {
    const actor = res.locals.actor as string;
    safeAudit({ tokenId: actor, tokenName: actor, action, result, detail }, actor);
  };

  app.get("/tokens", (_req, res) => send(res, tokensView(ctxOf(res), listTokens())));

  app.post("/tokens", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const form: TokenForm = {
      name: str(body.name),
      scopes: str(body.scopes),
      preset: str(body.preset),
      allowWildcard: body.allow_wildcard === "1",
    };
    const fail = (title: string, lines: string[] = []): void =>
      send(res, tokensView(ctxOf(res), listTokens(), { kind: "err", title, lines }, form), 422);
    try {
      let scopes: Scope[];
      if (form.preset && form.scopes.trim()) return fail("Use either a preset or explicit scopes, not both.");
      if (form.preset) {
        const p = PRESETS[form.preset];
        if (!p) return fail(`Unknown preset "${form.preset}".`);
        scopes = p.map((s) => ({ ...s }));
      } else {
        if (!form.scopes.trim()) return fail("Choose a preset or enter at least one scope.");
        scopes = scopesFromText(form.scopes);
      }
      const validated = validateTokenInput(form.name, scopes);
      const { kept, dropped } = dropRedundantScopes(validated.scopes);
      const warnings = wildcardWarnings(kept);
      if (warnings.length > 0 && !form.allowWildcard) {
        return fail("Wildcard scopes and presets grant broad access. Tick \"Allow wildcard\" to confirm. No token created.", warnings);
      }
      const created = createToken(validated.name, kept);
      auditAdmin(res, "admin_token_create", "ok", `${created.id} ${created.name} [${kept.map(formatScope).join(",")}]`);
      const notes = [
        ...warnings,
        ...dropped.map((s) => `Dropped redundant scope ${formatScope(s)} (already covered by a wildcard scope).`),
      ];
      send(res, tokenCreatedView(ctxOf(res), created, notes));
    } catch (err) {
      if (err instanceof TokenValidationError || (err instanceof Error && /^invalid scope/.test(err.message))) {
        return fail(err.message);
      }
      throw err;
    }
  });

  app.post("/tokens/:id/revoke", (req, res) => {
    const id = req.params.id as string;
    let banner: Banner;
    if (!UUID_RE.test(id)) {
      banner = { kind: "err", title: "Invalid token id." };
    } else if (revokeToken(id)) {
      auditAdmin(res, "admin_token_revoke", "ok", id);
      banner = { kind: "ok", title: `Token ${id} revoked.` };
    } else {
      auditAdmin(res, "admin_token_revoke", "error", `${id} not found or already revoked`);
      banner = { kind: "err", title: "Token not found or already revoked." };
    }
    send(res, tokensView(ctxOf(res), listTokens(), banner), banner.kind === "ok" ? 200 : 404);
  });

  // ---- inbox ----

  app.get("/inbox", async (_req, res, next) => {
    try {
      send(res, inboxView(ctxOf(res), await listInbox(vaultRoot)));
    } catch (err) {
      next(err);
    }
  });

  const listWith = async (res: Response, banner: Banner, status: number): Promise<void> =>
    send(res, inboxView(ctxOf(res), await listInbox(vaultRoot), banner), status);

  app.get("/inbox/:id", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      if (!isValidInboxId(id)) return void send(res, errorView(ctxOf(res), 400, "invalid proposal id"), 400);
      try {
        const p = await showProposal(vaultRoot, id);
        send(res, proposalView(ctxOf(res), p, req.query.view === "raw" ? "raw" : "rendered"));
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        send(res, errorView(ctxOf(res), err.status, err.message), err.status);
      }
    } catch (err) {
      next(err);
    }
  });

  app.post("/inbox/:id/accept", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      if (!isValidInboxId(id)) return void send(res, errorView(ctxOf(res), 400, "invalid proposal id"), 400);
      const overwrite = (req.body as Record<string, unknown>).overwrite === "1";
      try {
        const r = await acceptProposal(vaultRoot, id, overwrite, res.locals.actor as string);
        await listWith(res, { kind: "ok", title: `Accepted ${r.target}.`, lines: r.commit ? [`Commit ${r.commit}`] : [] }, 200);
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        if (err.status === 404) return void (await listWith(res, { kind: "err", title: err.message }, 404));
        try {
          const p = await showProposal(vaultRoot, id);
          send(res, proposalView(ctxOf(res), p, "rendered", { kind: "err", title: err.message }), err.status);
        } catch {
          await listWith(res, { kind: "err", title: err.message }, err.status);
        }
      }
    } catch (err) {
      next(err);
    }
  });

  app.post("/inbox/:id/reject", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      if (!isValidInboxId(id)) return void send(res, errorView(ctxOf(res), 400, "invalid proposal id"), 400);
      try {
        const r = await rejectProposal(vaultRoot, id, res.locals.actor as string);
        await listWith(res, { kind: "ok", title: `Rejected ${r.target}.` }, 200);
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        await listWith(res, { kind: "err", title: err.message }, err.status);
      }
    } catch (err) {
      next(err);
    }
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

// Binds all interfaces (Traefik reaches it over the overlay network); the peer check and
// the group check above are what protect it. Refuses to start without TRUSTED_PROXY.
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
  try {
    const app = createWebAdminApp({
      vaultRoot,
      trustedProxy,
      lifecycle,
      adminGroup: env.ADMIN_GROUP || DEFAULT_ADMIN_GROUP,
      secret: env.ADMIN_WEB_SECRET || undefined,
    });
    const s = await listen(app, port);
    console.log(`web admin listening on port ${port} (behind Traefik + Authelia only)`);
    return s;
  } catch (err) {
    console.error(`web admin disabled, cannot listen on port ${port}: ${errorMessage(err)}`);
    return undefined;
  }
}
