// Local-only admin listener (127.0.0.1) for reviewing the inbox (used by the CLI). It runs
// inside the server process so accept/reject use the same git write lock as every tool call;
// a separate CLI process must never run git on the vault concurrently. The operations live
// in admin/service.ts, shared with the web admin UI.
import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import { isValidInboxId } from "./inbox";
import { UnsafePathError } from "./vault/paths";
import { redact } from "./vault/git";
import { errorMessage } from "./tools/common";
import { acceptProposal, AdminError, CLI_ACTOR, listInbox, rejectProposal, showProposal } from "./admin/service";
import { migrateFrontmatter } from "./admin/migrate";
import { AccessError, approveRequest, denyRequest, listPendingRequests } from "./access";
import { listActiveSessions } from "./auth/sessions";
import { parseScopes } from "./cli/token";
import { listen } from "./listen";
import type { Lifecycle } from "./server";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 3001;

export function createAdminApp(vaultRoot: string, lifecycle?: Lifecycle): Express {
  const app = express();
  app.disable("x-powered-by");

  // Tracked like /mcp requests so shutdown waits for them before draining the write
  // queue and closing the DB; new ones are refused once shutdown began.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (lifecycle) {
      if (lifecycle.shuttingDown) {
        res.setHeader("Connection", "close");
        res.status(503).json({ error: "server is shutting down" });
        return;
      }
      lifecycle.enter(res);
    }
    next();
  });

  // Loopback-only by bind; also refuse foreign Host headers (DNS rebinding) and
  // non-JSON POSTs (a browser cannot send those cross-origin without a preflight).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "content-type must be application/json" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "10kb" }));

  app.get("/admin/inbox", async (_req, res, next) => {
    try {
      res.json(await listInbox(vaultRoot));
    } catch (err) {
      next(err);
    }
  });

  // Validates :id before any filesystem access.
  app.param("id", (req, res, next, id: string) => {
    if (!isValidInboxId(id)) {
      res.status(400).json({ error: "invalid proposal id" });
      return;
    }
    next();
  });

  // Service errors carry their HTTP status; everything else goes to the error handler.
  const fail = (res: Response, next: NextFunction, err: unknown): void => {
    if (err instanceof AdminError) res.status(err.status).json({ error: err.message });
    else if (err instanceof AccessError) res.status(err.status).json({ error: err.message, lines: err.lines });
    else next(err);
  };

  // Token-less session access requests (CLI: access-list / access-approve / access-deny).
  const REF_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  app.get("/admin/access", (req, res, next) => {
    try {
      res.json({ requests: listPendingRequests(), sessions: listActiveSessions() });
    } catch (err) {
      next(err);
    }
  });
  app.post("/admin/access/:ref/approve", (req, res, next) => {
    try {
      const ref = req.params.ref as string;
      if (!REF_RE.test(ref)) return void res.status(400).json({ error: "invalid request id" });
      const b = (req.body ?? {}) as { scope?: unknown; allowWildcard?: unknown };
      if (b.scope !== undefined && typeof b.scope !== "string") return void res.status(400).json({ error: "scope must be a string" });
      if (b.allowWildcard !== undefined && typeof b.allowWildcard !== "boolean") return void res.status(400).json({ error: "allowWildcard must be a boolean" });
      let scopes;
      try {
        scopes = b.scope ? parseScopes(b.scope) : undefined;
      } catch (err) {
        return void res.status(400).json({ error: errorMessage(err) });
      }
      const d = approveRequest(ref, { scopes, allowWildcard: b.allowWildcard === true, actor: CLI_ACTOR });
      res.json({ ok: true, ...d });
    } catch (err) {
      fail(res, next, err);
    }
  });
  app.post("/admin/access/:ref/deny", (req, res, next) => {
    try {
      const ref = req.params.ref as string;
      if (!REF_RE.test(ref)) return void res.status(400).json({ error: "invalid request id" });
      res.json({ ok: true, ...denyRequest(ref, CLI_ACTOR) });
    } catch (err) {
      fail(res, next, err);
    }
  });

  app.get("/admin/inbox/:id", async (req, res, next) => {
    try {
      res.json(await showProposal(vaultRoot, req.params.id as string));
    } catch (err) {
      fail(res, next, err);
    }
  });

  app.post("/admin/inbox/:id/accept", async (req, res, next) => {
    try {
      const overwrite = (req.body as { overwrite?: unknown } | undefined)?.overwrite;
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        return void res.status(400).json({ error: "overwrite must be a boolean" });
      }
      const r = await acceptProposal(vaultRoot, req.params.id as string, overwrite === true, CLI_ACTOR);
      res.json({ ok: true, id: r.id, target: r.target, commit: r.commit });
    } catch (err) {
      fail(res, next, err);
    }
  });

  app.post("/admin/inbox/:id/reject", async (req, res, next) => {
    try {
      const r = await rejectProposal(vaultRoot, req.params.id as string, CLI_ACTOR);
      res.json({ ok: true, id: r.id, target: r.target, commit: r.commit });
    } catch (err) {
      fail(res, next, err);
    }
  });

  app.post("/admin/migrate-frontmatter", async (_req, res, next) => {
    try {
      res.json({ ok: true, ...(await migrateFrontmatter(vaultRoot, CLI_ACTOR)) });
    } catch (err) {
      fail(res, next, err);
    }
  });

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  // Never leak internals; the real reason goes to the log and the audit row.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UnsafePathError) {
      console.error(`admin: ${redact(err.message)}`);
      if (!res.headersSent) res.status(403).json({ error: "inbox path not allowed" });
      return;
    }
    console.error(`admin error: ${redact(errorMessage(err))}`);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });
  return app;
}

export function adminPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ADMIN_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_ADMIN_PORT;
}

// Binds 127.0.0.1 only; rejects on listen errors.
export const listenAdmin = (app: Express, port: number): Promise<Server> => listen(app, port, ADMIN_HOST);

// Starts the admin listener; a failure is logged, not fatal (the MCP server keeps running).
export async function startAdmin(vaultRoot: string, lifecycle?: Lifecycle, port = adminPort()): Promise<Server | undefined> {
  try {
    const s = await listenAdmin(createAdminApp(vaultRoot, lifecycle), port);
    console.log(`admin listener on ${ADMIN_HOST}:${port} (local only)`);
    return s;
  } catch (err) {
    console.error(`admin listener disabled, cannot listen on ${ADMIN_HOST}:${port}: ${errorMessage(err)}`);
    return undefined;
  }
}

// Server-like handle that closes the main and admin servers together (for createShutdown).
export function withAdmin(
  main: Pick<Server, "close" | "closeAllConnections">,
  admin: Server | undefined,
): Pick<Server, "close" | "closeAllConnections"> {
  if (!admin) return main;
  return {
    close: ((cb?: (err?: Error) => void) => {
      admin.close();
      return main.close(cb);
    }) as Server["close"],
    closeAllConnections: () => {
      admin.closeAllConnections();
      main.closeAllConnections();
    },
  };
}
