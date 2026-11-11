import dns from "node:dns";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyToken } from "./auth/tokens";
import { TokenContext, tokenContextStorage } from "./auth/context";
import { db } from "./db";
import { logAudit, logAuthFailure, MAX_FIELD_LEN } from "./audit";
import { createMcpServer } from "./mcp";
import {
  abortPendingPushes,
  BootstrapAbortedError,
  drainWrites,
  ensureVaultRepo,
  getSyncStatus,
  hasRemote,
  redact,
  refreshConflictBranches,
  runGit,
  setSyncEventHandler,
  startPeriodicSync,
  type SyncConflictEvent,
} from "./vault/git";

export const BODY_LIMIT = "1mb";
const DRAIN_TIMEOUT_MS = 25_000;

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// ---- in-flight tracking --------------------------------------------------

// Counts /mcp requests from entry (before auth/body parsing) to response
// finish/close, so shutdown can wait for them before draining the write queue.
export class Lifecycle {
  shuttingDown = false;
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  get inFlight(): number {
    return this.inflight;
  }

  enter(res: Response): void {
    this.inflight++;
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      if (--this.inflight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    };
    res.once("finish", leave);
    res.once("close", leave);
  }

  waitIdle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

// ---- trusted proxies ------------------------------------------------------

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

export interface TrustedProxy {
  trust: (addr: string) => boolean;
  refresh: () => Promise<void>;
  stop: () => void;
}

function normalizeIp(addr: string): string {
  return addr.startsWith("::ffff:") && net.isIPv4(addr.slice(7)) ? addr.slice(7) : addr;
}

// TRUSTED_PROXY: comma-separated hostnames, IPs or CIDRs. XFF is honoured only
// when the direct peer is in the set. Hostnames are resolved by refresh() and
// cached; trust() never waits on DNS. Empty spec trusts nobody.
export function createTrustedProxy(
  spec: string | undefined,
  resolve: Resolver = defaultResolver,
  refreshMs = 60_000,
): TrustedProxy {
  const entries = (spec ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const fixed: Array<{ addr: string; prefix?: number }> = [];
  const hosts: string[] = [];
  for (const e of entries) {
    const [addr, prefix] = e.split("/");
    if (net.isIP(addr) === 0) hosts.push(e);
    else fixed.push({ addr, prefix: prefix === undefined ? undefined : Number(prefix) });
  }
  const fam = (a: string): "ipv4" | "ipv6" => (net.isIPv4(a) ? "ipv4" : "ipv6");

  const resolved = new Map<string, string[]>();
  // Replaced atomically on refresh; trust() only ever reads it.
  let list = new net.BlockList();
  const rebuild = (): void => {
    const next = new net.BlockList();
    for (const f of fixed) {
      if (f.prefix === undefined) next.addAddress(f.addr, fam(f.addr));
      else next.addSubnet(f.addr, f.prefix, fam(f.addr));
    }
    for (const addrs of resolved.values()) for (const a of addrs) next.addAddress(a, fam(a));
    list = next;
  };
  rebuild();

  const refresh = async (): Promise<void> => {
    await Promise.all(
      hosts.map(async (h) => {
        try {
          resolved.set(h, await resolve(h));
        } catch (err) {
          // Keep the last good answer for this host.
          console.error(`TRUSTED_PROXY: cannot resolve ${h}: ${redact(String(err))}`);
        }
      }),
    );
    rebuild();
  };

  let timer: NodeJS.Timeout | undefined;
  if (hosts.length > 0) {
    timer = setInterval(() => void refresh(), refreshMs);
    timer.unref();
  }

  return {
    trust: (addr) => {
      const ip = normalizeIp(addr);
      const family = net.isIP(ip);
      return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
    },
    refresh,
    stop: () => timer && clearInterval(timer),
  };
}

// ---- auth-failure limiter -------------------------------------------------

// In-memory, per client IP. After `max` failures inside one window the IP is
// blocked until the window ends; audit rows are coalesced to one per window.
export class AuthFailureLimiter {
  private readonly map = new Map<string, { start: number; count: number; previous: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(ip: string): boolean {
    const e = this.map.get(ip);
    return !!e && this.now() - e.start < this.windowMs && e.count >= this.max;
  }

  // Records a failure. `audit` is true for the first failure of a window;
  // `previous` is the failure count of the window that just ended.
  record(ip: string): { audit: boolean; previous: number } {
    const t = this.now();
    const e = this.map.get(ip);
    if (e && t - e.start < this.windowMs) {
      e.count++;
      return { audit: false, previous: 0 };
    }
    this.map.delete(ip); // re-insert so eviction order follows window starts
    this.map.set(ip, { start: t, count: 1, previous: 0 });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value as string);
    }
    return { audit: true, previous: e?.count ?? 0 };
  }
}

export interface AppOptions {
  vaultRoot: string;
  lifecycle?: Lifecycle;
  trustedProxy?: TrustedProxy;
  authLimiter?: AuthFailureLimiter;
}

// Bearer-token auth, mounted before the MCP route. No MCP involved on failure.
function makeBearerAuth(limiter: AuthFailureLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "unknown";
    if (limiter.blocked(ip)) {
      jsonRpcError(res, 429, -32000, "Too many failed authentications");
      return;
    }

    const fail = (reason: string): void => {
      const { audit, previous } = limiter.record(ip);
      if (audit) {
        // A DB failure here must still yield a 401.
        try {
          logAuthFailure({
            clientIp: req.ip,
            reason: previous > 1 ? `${reason} (previous minute: ${previous} failures)` : reason,
          });
        } catch (err) {
          console.error("auth failure audit write failed:", redact(String(err)));
        }
      }
      res.status(401).json({ error: reason });
    };

    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!match) return fail("missing or malformed Authorization header");

    const verified = verifyToken(match[1]);
    if (!verified) return fail("invalid or revoked token");

    const ctx: TokenContext = {
      tokenId: verified.tokenId,
      name: verified.name,
      scopes: verified.scopes,
      clientIp: req.ip,
    };
    // Also on res.locals: the error handler runs from stream callbacks where the
    // AsyncLocalStorage store is not reliably propagated.
    res.locals.tokenContext = ctx;
    tokenContextStorage.run(ctx, next);
  };
}

// Cheap liveness checks only (no child processes).
function dbOk(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function vaultOk(vaultRoot: string): boolean {
  return existsSync(path.join(vaultRoot, ".git"));
}

// Filled by initVault so /health/details never has to spawn git per call.
const bootInfo = new Map<string, { hasRemote: boolean; branch: string }>();

// Compact JSON audit detail, most important fields first, always within the
// audit field cap (list sizes shrink and "more" counts what was left out).
export function syncConflictDetail(e: SyncConflictEvent): string {
  const shortSha = (c: string): string => c.slice(0, 12);
  let tokens = e.tokens.slice(0, 5);
  let paths = e.paths.slice(0, 3).map((p) => (p.length > 60 ? `${p.slice(0, 59)}…` : p));
  const build = (): string => {
    const more = e.tokens.length - tokens.length + (e.paths.length - paths.length);
    const d: Record<string, unknown> = { origin: e.origin, branch: e.backupBranch };
    if (!e.ok) {
      d.ok = false;
      d.error = (e.error ?? "recovery failed").slice(0, 80);
    }
    d.tokens = tokens;
    d.paths = paths;
    d.commits = e.commits.length;
    if (e.commits.length > 0) {
      d.first = shortSha(e.commits[e.commits.length - 1]);
      d.last = shortSha(e.commits[0]);
    }
    if (more > 0) d.more = more;
    return JSON.stringify(d);
  };
  let out = build();
  while (out.length > MAX_FIELD_LEN && (paths.length > 0 || tokens.length > 0)) {
    if (paths.length > 0) paths = paths.slice(0, -1);
    else tokens = tokens.slice(0, -1);
    out = build();
  }
  return out;
}

// Records an async sync conflict (acknowledged commits moved to a backup
// branch) in the audit log under a fixed system identity. Synchronous write-path
// conflicts are already audited by the tool's own row, so only background
// origins are written here.
export function auditSyncConflict(e: SyncConflictEvent): void {
  if (e.origin === "write") return;
  try {
    logAudit({
      tokenId: "system",
      tokenName: "git-sync",
      action: "sync_conflict",
      result: "error",
      detail: syncConflictDetail(e),
      gitCommit: e.commits[0],
    });
  } catch (err) {
    console.error(`audit write failed (sync_conflict ${e.backupBranch}): ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}

export function createApp(opts: AppOptions): Express {
  const { vaultRoot } = opts;
  const lifecycle = opts.lifecycle ?? new Lifecycle();
  const limiter = opts.authLimiter ?? new AuthFailureLimiter();
  const bearerAuth = makeBearerAuth(limiter);
  const key = path.resolve(vaultRoot);

  const app = express();
  app.disable("x-powered-by");
  // Trust X-Forwarded-For only from the configured proxies (TRUSTED_PROXY);
  // otherwise req.ip is the socket address.
  const proxy = opts.trustedProxy;
  app.set("trust proxy", proxy ? (addr: string) => proxy.trust(addr) : false);

  // Public: status only. 503 only for broken DB/vault (restart helps); sync
  // trouble never fails it so network blips don't loop the container.
  app.get("/health", (_req, res) => {
    const ok = dbOk() && vaultOk(vaultRoot);
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "error" });
  });

  // Detailed view, any valid token.
  app.get("/health/details", bearerAuth, async (_req, res) => {
    const dbUp = dbOk();
    const vaultUp = vaultOk(vaultRoot);
    let info = bootInfo.get(key);
    if (!info && vaultUp) {
      // Not bootstrapped through initVault (tests): compute once, then cache.
      try {
        info = { hasRemote: await hasRemote(vaultRoot), branch: "" };
        bootInfo.set(key, info);
      } catch {
        /* reported as false */
      }
    }
    if (vaultUp) await refreshConflictBranches(vaultRoot);
    const sync = getSyncStatus(vaultRoot);
    const broken = !dbUp || !vaultUp;
    const degraded = sync.lastPushOk === false || sync.conflictBranches.length > 0;
    res.status(broken ? 503 : 200).json({
      status: broken ? "error" : degraded ? "degraded" : "ok",
      db: dbUp ? "ok" : "error",
      vault: vaultUp ? "ok" : "error",
      sync: {
        hasRemote: info?.hasRemote ?? false,
        branch: info?.branch || null,
        unpushed: sync.unpushed,
        lastPushOk: sync.lastPushOk,
        conflicts: sync.conflictBranches.length,
        conflictBranches: sync.conflictBranches,
      },
    });
  });

  // Track in-flight /mcp requests from the very start (before auth and body
  // parsing) and refuse new ones once shutdown began.
  app.use("/mcp", (_req, res, next) => {
    if (lifecycle.shuttingDown) {
      res.setHeader("Connection", "close");
      jsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }
    lifecycle.enter(res);
    next();
  });

  // Body parsing only after auth, so unauthenticated callers can't make us
  // buffer anything.
  app.use("/mcp", bearerAuth, express.json({ limit: BODY_LIMIT }));

  // Stateless Streamable HTTP mode: a fresh McpServer + transport per request,
  // no session state kept between calls.
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(vaultRoot);
    let transport: StreamableHTTPServerTransport | undefined;
    let cleanedUp = false;

    // Registered right after transport creation (before any await) so a client
    // disconnect while handleRequest is pending is never missed; also reachable
    // from the catch block. Guarded so it is safe to run from both places.
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        transport?.close();
      } catch (err) {
        console.error("Error closing MCP transport:", err);
      }
      try {
        server.close();
      } catch (err) {
        console.error("Error closing MCP server:", err);
      }
    };

    try {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", cleanup);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      cleanup();
    }
  });

  // Stateless mode doesn't support SSE streams or session termination.
  const notAllowed = (_req: Request, res: Response): void =>
    jsonRpcError(res, 405, -32000, "Method not allowed.");
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Final error handler: JSON-RPC envelope, never a stack trace.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { type?: string; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
    const errStatus = e.status ?? e.statusCode;
    let status = 500;
    let code = -32603;
    let message = "Internal server error";
    if (e.type === "entity.too.large") {
      status = 413;
      code = -32600;
      message = "Request too large (max 1 MB)";
    } else if (e.type === "entity.parse.failed") {
      status = 400;
      code = -32700;
      message = "Parse error: invalid JSON";
    } else if (
      typeof errStatus === "number" &&
      Number.isInteger(errStatus) &&
      errStatus >= 400 &&
      errStatus < 500 &&
      e.expose === true &&
      typeof e.message === "string"
    ) {
      // body-parser / raw-body client errors (415 charset/encoding, 400 aborted, ...).
      status = errStatus;
      code = -32600;
      message = e.message;
    }
    if (status === 500) console.error("Unhandled request error:", err);

    const ctx = res.locals.tokenContext as TokenContext | undefined;
    if (ctx) {
      try {
        logAudit({
          tokenId: ctx.tokenId,
          tokenName: ctx.name,
          action: "http",
          result: "error",
          detail: `${status} ${message}`,
          clientIp: ctx.clientIp ?? req.ip,
        });
      } catch (auditErr) {
        console.error("audit write failed:", redact(String(auditErr)));
      }
    }
    jsonRpcError(res, status, code, message);
  });

  return app;
}

// ---- bootstrap / shutdown ------------------------------------------------

// Ensures the vault is a usable git repo (init/clone as needed) and returns a
// one-line, credential-free description for the startup log. Also caches the
// remote/branch facts for /health/details.
export async function initVault(
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  shouldAbort?: () => boolean,
): Promise<string> {
  const branch = env.VAULT_BRANCH || "main";
  await ensureVaultRepo(vaultRoot, {
    remoteUrl: env.VAULT_REMOTE_URL || undefined,
    branch,
    shouldAbort,
  });
  const remote = await hasRemote(vaultRoot);
  bootInfo.set(path.resolve(vaultRoot), { hasRemote: remote, branch });
  let head = "none";
  try {
    head = (await runGit(["rev-parse", "--short", "HEAD"], vaultRoot)).trim();
  } catch {
    /* no commits yet */
  }
  return `vault ok: repo=yes remote=${remote ? "yes" : "no"} branch=${branch} head=${head}`;
}

export interface ShutdownDeps {
  server: Pick<Server, "close"> & Partial<Pick<Server, "closeAllConnections">>;
  lifecycle?: Lifecycle;
  stopSync?: () => void;
  closeDb: () => void;
  abortPushes?: () => void;
  drain?: () => Promise<void>;
  // One overall cap for waiting on in-flight requests AND the write queue.
  drainTimeoutMs?: number;
  exit?: (code: number) => void;
}

// Idempotent: the first call shuts down gracefully, any later call (second
// signal) exits immediately.
export function createShutdown(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const drain = deps.drain ?? drainWrites;
  const abortPushes = deps.abortPushes ?? abortPendingPushes;
  const timeoutMs = deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  let started = false;

  return async (signal = "shutdown") => {
    if (started) {
      console.error(`${signal} received again, exiting immediately`);
      exit(1);
      return;
    }
    started = true;
    console.log(`${signal} received, shutting down`);

    // Stop accepting: new /mcp requests get 503, the listener closes.
    if (deps.lifecycle) deps.lifecycle.shuttingDown = true;
    const closed = new Promise<void>((resolve) => deps.server.close(() => resolve()));
    deps.stopSync?.();
    // Pushes are network-only and retried by the next periodic sync; local
    // add/commit may still finish within the cap.
    abortPushes();

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      // In-flight requests first (they may still enter the write queue), then
      // the queue itself.
      const work = (async () => {
        await deps.lifecycle?.waitIdle();
        await drain();
        return "drained" as const;
      })();
      const r = await Promise.race([work, timedOut]);
      if (r === "timeout") console.error(`in-flight work did not finish within ${timeoutMs} ms`);
    } catch (err) {
      console.error("error while draining writes:", err);
    } finally {
      clearTimeout(timer);
    }

    // Cut remaining (keep-alive) connections so close() can finish.
    deps.server.closeAllConnections?.();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1000).unref())]);
    try {
      deps.closeDb();
    } catch (err) {
      console.error("error closing DB:", err);
    }
    exit(0);
  };
}

// Rejects on listen errors (EADDRINUSE, EACCES, ...): Express 5 hands them to
// the callback.
export function listen(app: Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, (err?: Error) => (err ? reject(err) : resolve(s)));
  });
}

export async function start(): Promise<{ server: Server; shutdown: (signal?: string) => Promise<void> }> {
  const vaultRoot = process.env.VAULT_PATH;
  if (!vaultRoot) {
    console.error("VAULT_PATH environment variable is required");
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;

  // Signal handlers first: a signal during bootstrap stops startup after the
  // current git step; once running, they trigger the graceful shutdown.
  let stopRequested = false;
  let shutdown: ((signal?: string) => Promise<void>) | undefined;
  const onSignal = (sig: string): void => {
    if (shutdown) {
      void shutdown(sig);
    } else if (stopRequested) {
      console.error(`${sig} received again, exiting immediately`);
      process.exit(1);
    } else {
      stopRequested = true;
      console.log(`${sig} received during startup, stopping after the current step`);
    }
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  const exitIfStopped = (): void => {
    if (stopRequested) {
      console.log("startup interrupted by signal, exiting");
      process.exit(0);
    }
  };

  try {
    console.log(await initVault(vaultRoot, process.env, () => stopRequested));
  } catch (err) {
    if (err instanceof BootstrapAbortedError) exitIfStopped();
    console.error(`vault bootstrap failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  }
  exitIfStopped();

  const trustedProxy = createTrustedProxy(process.env.TRUSTED_PROXY);
  await trustedProxy.refresh();
  exitIfStopped();

  const lifecycle = new Lifecycle();
  const app = createApp({ vaultRoot, lifecycle, trustedProxy });
  let server: Server;
  try {
    server = await listen(app, port);
  } catch (err) {
    console.error(`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`second-brain-mcp listening on port ${port}`);

  setSyncEventHandler(auditSyncConflict);
  const intervalRaw = process.env.VAULT_SYNC_INTERVAL_MS;
  const intervalMs = intervalRaw === undefined || intervalRaw === "" ? 60_000 : Number(intervalRaw);
  const stopSync = intervalMs > 0 ? startPeriodicSync(vaultRoot, intervalMs) : undefined;

  shutdown = createShutdown({
    server,
    lifecycle,
    stopSync: () => {
      stopSync?.();
      trustedProxy.stop();
    },
    closeDb: () => db.close(),
  });
  // A signal that landed between listen and here.
  if (stopRequested) void shutdown("SIGTERM");
  return { server, shutdown };
}

// Guard so this module can be imported for testing without binding a port.
if (require.main === module) {
  start().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
