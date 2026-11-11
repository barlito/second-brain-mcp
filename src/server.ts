import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyToken } from "./auth/tokens";
import { TokenContext, tokenContextStorage } from "./auth/context";
import { db } from "./db";
import { logAudit, logAuthFailure } from "./audit";
import { createMcpServer } from "./mcp";
import { drainWrites, ensureVaultRepo, getSyncStatus, hasRemote, startPeriodicSync } from "./vault/git";

export const BODY_LIMIT = "1mb";
const DRAIN_TIMEOUT_MS = 25_000;

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function redact(text: string): string {
  return text.replace(/:\/\/[^@\/]+@/g, "://***@");
}

// Bearer-token auth, mounted before the MCP route. No MCP involved on failure.
function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match) {
    logAuthFailure({ clientIp: req.ip, reason: "missing or malformed Authorization header" });
    res.status(401).json({ error: "missing or malformed Authorization header" });
    return;
  }

  const verified = verifyToken(match[1]);
  if (!verified) {
    logAuthFailure({ clientIp: req.ip, reason: "invalid or revoked token" });
    res.status(401).json({ error: "invalid or revoked token" });
    return;
  }

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
}

function vaultReadable(vaultRoot: string): boolean {
  try {
    const gitDir = path.join(vaultRoot, ".git");
    if (!existsSync(gitDir)) return false;
    accessSync(vaultRoot, fsConstants.R_OK);
    readFileSync(path.join(gitDir, "HEAD"), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function createApp({ vaultRoot }: { vaultRoot: string }): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: Traefik

  // Unauthenticated, no secrets. 503 only for broken DB/vault (restart
  // helps); sync trouble is "degraded" with 200 so network blips don't loop.
  app.get("/health", async (_req, res) => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const vaultOk = vaultReadable(vaultRoot);
    let remote = false;
    if (vaultOk) {
      try {
        remote = await hasRemote(vaultRoot);
      } catch {
        remote = false;
      }
    }
    const sync = getSyncStatus(vaultRoot);
    const broken = !dbOk || !vaultOk;
    const degraded = sync.lastPushOk === false || sync.conflictBranches.length > 0;
    res.status(broken ? 503 : 200).json({
      status: broken ? "error" : degraded ? "degraded" : "ok",
      db: dbOk ? "ok" : "error",
      vault: vaultOk ? "ok" : "error",
      sync: {
        hasRemote: remote,
        unpushed: sync.unpushed,
        lastPushOk: sync.lastPushOk,
        conflicts: sync.conflictBranches.length,
      },
    });
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
    const type = (err as { type?: string }).type;
    let status = 500;
    let code = -32603;
    let message = "Internal server error";
    if (type === "entity.too.large") {
      status = 413;
      code = -32600;
      message = "Request too large (max 1 MB)";
    } else if (type === "entity.parse.failed") {
      status = 400;
      code = -32700;
      message = "Parse error: invalid JSON";
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

function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 15_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
}

// Ensures the vault is a usable git repo (init/clone as needed) and returns a
// one-line, credential-free description for the startup log.
export async function initVault(
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const branch = env.VAULT_BRANCH || "main";
  await ensureVaultRepo(vaultRoot, { remoteUrl: env.VAULT_REMOTE_URL || undefined, branch });
  const remote = await hasRemote(vaultRoot);
  let head = "none";
  try {
    head = await gitOut(["rev-parse", "--short", "HEAD"], vaultRoot);
  } catch {
    /* no commits yet */
  }
  return `vault ok: repo=yes remote=${remote ? "yes" : "no"} branch=${branch} head=${head}`;
}

export interface ShutdownDeps {
  server: Pick<Server, "close"> & Partial<Pick<Server, "closeAllConnections">>;
  stopSync?: () => void;
  closeDb: () => void;
  drain?: () => Promise<void>;
  drainTimeoutMs?: number;
  exit?: (code: number) => void;
}

// Idempotent: the first call shuts down gracefully, any later call (second
// signal) exits immediately.
export function createShutdown(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const drain = deps.drain ?? drainWrites;
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

    const closed = new Promise<void>((resolve) => deps.server.close(() => resolve()));
    deps.stopSync?.();

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const r = await Promise.race([drain().then(() => "drained" as const), timedOut]);
      if (r === "timeout") console.error(`pending writes did not drain within ${timeoutMs} ms`);
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

export async function start(): Promise<{ server: Server; shutdown: (signal?: string) => Promise<void> }> {
  const vaultRoot = process.env.VAULT_PATH;
  if (!vaultRoot) {
    console.error("VAULT_PATH environment variable is required");
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;

  try {
    console.log(await initVault(vaultRoot));
  } catch (err) {
    console.error(`vault bootstrap failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  }

  const intervalRaw = process.env.VAULT_SYNC_INTERVAL_MS;
  const intervalMs = intervalRaw === undefined || intervalRaw === "" ? 60_000 : Number(intervalRaw);
  const stopSync = intervalMs > 0 ? startPeriodicSync(vaultRoot, intervalMs) : undefined;

  const app = createApp({ vaultRoot });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`second-brain-mcp listening on port ${port}`);
      resolve(s);
    });
  });

  const shutdown = createShutdown({ server, stopSync, closeDb: () => db.close() });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return { server, shutdown };
}

// Guard so this module can be imported for testing without binding a port.
if (require.main === module) {
  start().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
