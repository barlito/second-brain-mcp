// Local-only admin listener (127.0.0.1) for reviewing the inbox. It runs inside the
// server process so accept/reject use the same git write lock as every tool call;
// a separate CLI process must never run git on the vault concurrently.
import { promises as fsp } from "node:fs";
import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import {
  INBOX_DIR,
  inboxPath,
  isValidInboxId,
  ID_RE,
  parseProposal,
  Proposal,
  splitTarget,
} from "./inbox";
import { INBOX_SPACE } from "./acl/check";
import { readFileNoFollow } from "./vault/enumerate";
import { isValidSlug, resolveNotePath } from "./vault/paths";
import { InboxMissingError, NoteExistsError, redact, syncInboxResolve } from "./vault/git";
import { errorMessage, safeAudit } from "./tools/common";
import { NoteRuleError, validateNoteContent } from "./tools/conventions";
import { ARCHIVE_SECTION } from "./tools/reserved";
import path from "node:path";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 3001;
const ADMIN_ACTOR = "admin-cli";
const MAX_PROPOSAL_BYTES = 1024 * 1024;

async function load(vaultRoot: string, id: string): Promise<{ p: Proposal | null; size: number } | undefined> {
  try {
    const r = await readFileNoFollow(inboxPath(vaultRoot, id), MAX_PROPOSAL_BYTES);
    if (!r) return undefined;
    return { p: parseProposal(id, r.content), size: r.bytes };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function audit(action: string, id: string, p: Proposal, result: "ok" | "error", detail: string, gitCommit?: string): void {
  const t = splitTarget(p.target);
  safeAudit(
    { tokenId: ADMIN_ACTOR, tokenName: ADMIN_ACTOR, action, ...(t ?? {}), result, detail: `${id} ${detail}`, gitCommit },
    ADMIN_ACTOR,
  );
}

export function createAdminApp(vaultRoot: string): Express {
  const app = express();
  app.disable("x-powered-by");

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
      let names: string[] = [];
      try {
        names = await fsp.readdir(path.join(path.resolve(vaultRoot), INBOX_DIR));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const items: unknown[] = [];
      for (const n of names.sort()) {
        const id = n.endsWith(".md") ? n.slice(0, -3) : "";
        if (!ID_RE.test(id)) continue;
        const l = await load(vaultRoot, id).catch(() => undefined);
        if (!l) continue;
        items.push({
          id,
          target: l.p?.target ?? null,
          proposed_by: l.p?.proposedBy ?? null,
          reason: l.p?.reason ?? null,
          created: l.p?.created ?? null,
          size: l.size,
        });
      }
      res.json({ proposals: items });
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

  app.get("/admin/inbox/:id", async (req, res, next) => {
    try {
      const l = await load(vaultRoot, req.params.id as string);
      if (!l) return void res.status(404).json({ error: "proposal not found" });
      if (!l.p) return void res.status(422).json({ error: "malformed proposal file" });
      const { proposedBy, ...rest } = l.p;
      res.json({ ...rest, proposed_by: proposedBy, size: l.size });
    } catch (err) {
      next(err);
    }
  });

  app.post("/admin/inbox/:id/accept", async (req, res, next) => {
    const id = req.params.id as string;
    try {
      const overwrite = (req.body as { overwrite?: unknown } | undefined)?.overwrite;
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        return void res.status(400).json({ error: "overwrite must be a boolean" });
      }
      const l = await load(vaultRoot, id);
      if (!l) return void res.status(404).json({ error: "proposal not found" });
      if (!l.p) return void res.status(422).json({ error: "malformed proposal file" });
      const p = l.p;

      const t = splitTarget(p.target);
      if (!t || ![t.space, t.project, t.section, t.note].every(isValidSlug) || t.space === INBOX_SPACE || t.section === ARCHIVE_SECTION) {
        return void res.status(422).json({ error: "proposal has an invalid target" });
      }
      try {
        validateNoteContent(t, p.content);
      } catch (err) {
        if (err instanceof NoteRuleError) return void res.status(422).json({ error: err.message });
        throw err;
      }
      const targetAbs = resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note);
      try {
        const { commitSha } = await syncInboxResolve(
          vaultRoot,
          inboxPath(vaultRoot, id),
          { targetAbs, content: p.content, overwrite: overwrite === true },
          `inbox accept: ${p.target} (proposed by ${p.proposedBy})`,
        );
        audit("inbox_accept", id, p, "ok", overwrite ? "overwrite" : "create", commitSha);
        res.json({ ok: true, id, target: p.target, commit: commitSha });
      } catch (err) {
        if (err instanceof NoteExistsError) {
          audit("inbox_accept", id, p, "error", "target exists");
          return void res.status(409).json({ error: "target note already exists (use overwrite)" });
        }
        if (err instanceof InboxMissingError) return void res.status(404).json({ error: "proposal not found" });
        audit("inbox_accept", id, p, "error", redact(errorMessage(err)));
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  app.post("/admin/inbox/:id/reject", async (req, res, next) => {
    const id = req.params.id as string;
    try {
      const l = await load(vaultRoot, id);
      if (!l) return void res.status(404).json({ error: "proposal not found" });
      // A malformed file can still be rejected (removed).
      const p = l.p ?? { id, target: "(malformed)", proposedBy: "unknown", reason: "", created: "", content: "" };
      try {
        const { commitSha } = await syncInboxResolve(
          vaultRoot,
          inboxPath(vaultRoot, id),
          null,
          `inbox reject: ${p.target} (proposed by ${p.proposedBy})`,
        );
        audit("inbox_reject", id, p, "ok", "rejected", commitSha);
        res.json({ ok: true, id, target: p.target, commit: commitSha });
      } catch (err) {
        if (err instanceof InboxMissingError) return void res.status(404).json({ error: "proposal not found" });
        audit("inbox_reject", id, p, "error", redact(errorMessage(err)));
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  // Never leak internals; the real reason goes to the log and the audit row.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`admin error: ${redact(errorMessage(err))}`);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });
  return app;
}

// Binds 127.0.0.1 only; rejects on listen errors.
export function listenAdmin(app: Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, ADMIN_HOST, (err?: Error) => (err ? reject(err) : resolve(s)));
  });
}

export function adminPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ADMIN_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_ADMIN_PORT;
}

// Starts the admin listener; a failure is logged, not fatal (the MCP server keeps running).
export async function startAdmin(vaultRoot: string, port = adminPort()): Promise<Server | undefined> {
  try {
    const s = await listenAdmin(createAdminApp(vaultRoot), port);
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
