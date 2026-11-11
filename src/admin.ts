// Local-only admin listener (127.0.0.1) for reviewing the inbox. It runs inside the
// server process so accept/reject use the same git write lock as every tool call;
// a separate CLI process must never run git on the vault concurrently.
import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import {
  assertInboxDirSafe,
  HEAD_BYTES,
  inboxPath,
  isValidInboxId,
  listHeads,
  MAX_ADMIN_READ_BYTES,
  parseProposal,
  parseProposalHead,
  Proposal,
  readBounded,
  splitTarget,
} from "./inbox";
import { isValidSlug, resolveNotePath, UnsafePathError } from "./vault/paths";
import { InboxInvalidError, InboxMissingError, NoteExistsError, redact, syncInboxResolve } from "./vault/git";
import { errorMessage, MAX_CONTENT_CHARS, safeAudit } from "./tools/common";
import { NoteRuleError, validateNoteContent } from "./tools/conventions";
import { rejectReservedSection } from "./tools/reserved";
import { listen } from "./listen";
import type { Lifecycle } from "./server";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 3001;
const ADMIN_ACTOR = "admin-cli";

// Proposal read for show; undefined when missing. The inbox dir is checked first so a
// symlinked dir is never followed; the file itself is opened O_NOFOLLOW.
async function loadForShow(vaultRoot: string, id: string): Promise<{ p: Proposal | null; size: number } | "too-large" | undefined> {
  assertInboxDirSafe(vaultRoot);
  try {
    const r = await readBounded(inboxPath(vaultRoot, id), MAX_ADMIN_READ_BYTES);
    if (!r) return undefined;
    if (r.truncated) return "too-large";
    return { p: parseProposal(id, r.text), size: r.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function audit(action: string, id: string, p: { target: string }, result: "ok" | "error", detail: string, gitCommit?: string): void {
  const t = splitTarget(p.target);
  safeAudit(
    { tokenId: ADMIN_ACTOR, tokenName: ADMIN_ACTOR, action, ...(t ?? {}), result, detail: `${id} ${detail}`, gitCommit },
    ADMIN_ACTOR,
  );
}

// Same rules kb_write applies, on what is about to be accepted. Throws on violation.
function validateAccept(raw: Buffer, id: string): { p: Proposal; t: NonNullable<ReturnType<typeof splitTarget>> } {
  if (raw.length > MAX_ADMIN_READ_BYTES) throw new InboxInvalidError("proposal file too large");
  const p = parseProposal(id, raw.toString("utf8"));
  if (!p) throw new InboxInvalidError("malformed proposal file");
  const t = splitTarget(p.target);
  if (!t || ![t.space, t.project, t.section, t.note].every(isValidSlug)) {
    throw new InboxInvalidError("proposal has an invalid target");
  }
  const reserved = rejectReservedSection(t.section);
  if (reserved) throw new InboxInvalidError((reserved.toolResult.content[0] as { text: string }).text);
  if (p.content.length > MAX_CONTENT_CHARS) throw new InboxInvalidError("content too large (max 512 KB)");
  validateNoteContent(t, p.content);
  return { p, t };
}

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
      const { items, truncated } = await listHeads(vaultRoot);
      res.json({
        proposals: items.map(({ id, head, size }) => ({
          id,
          target: head?.target ?? null,
          proposed_by: head?.proposedBy ?? null,
          reason: head?.reason ?? null,
          created: head?.created ?? null,
          size,
        })),
        truncated,
      });
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
      const l = await loadForShow(vaultRoot, req.params.id as string);
      if (!l) return void res.status(404).json({ error: "proposal not found" });
      if (l === "too-large") return void res.status(413).json({ error: "proposal too large to show; reject it" });
      if (!l.p) return void res.status(422).json({ error: "malformed proposal file" });
      const { proposedBy, ...rest } = l.p;
      res.json({ ...rest, proposed_by: proposedBy, size: l.size });
    } catch (err) {
      next(err);
    }
  });

  // Accept: load, parse and validate INSIDE the write lock (after the pull), so exactly
  // what is validated is what gets committed.
  app.post("/admin/inbox/:id/accept", async (req, res, next) => {
    const id = req.params.id as string;
    let seen: { target: string } = { target: "(unknown)" };
    try {
      const overwrite = (req.body as { overwrite?: unknown } | undefined)?.overwrite;
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        return void res.status(400).json({ error: "overwrite must be a boolean" });
      }
      try {
        const { commitSha } = await syncInboxResolve(vaultRoot, inboxPath(vaultRoot, id), (raw) => {
          const { p, t } = validateAccept(raw, id);
          seen = p;
          return {
            message: `inbox accept: ${p.target} (proposed by ${p.proposedBy})`,
            accept: {
              targetAbs: resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note),
              content: p.content,
              overwrite: overwrite === true,
            },
          };
        });
        audit("inbox_accept", id, seen, "ok", overwrite ? "overwrite" : "create", commitSha ?? undefined);
        res.json({ ok: true, id, target: seen.target, commit: commitSha });
      } catch (err) {
        if (err instanceof NoteExistsError) {
          audit("inbox_accept", id, seen, "error", "target exists");
          return void res.status(409).json({ error: "target note already exists (use overwrite)" });
        }
        if (err instanceof InboxMissingError) return void res.status(404).json({ error: "proposal not found" });
        if (err instanceof InboxInvalidError || err instanceof NoteRuleError) {
          audit("inbox_accept", id, seen, "error", err.message);
          return void res.status(422).json({ error: err.message });
        }
        audit("inbox_accept", id, seen, "error", redact(errorMessage(err)));
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  app.post("/admin/inbox/:id/reject", async (req, res, next) => {
    const id = req.params.id as string;
    let seen: { target: string } = { target: "(unknown)" };
    try {
      try {
        const { commitSha } = await syncInboxResolve(vaultRoot, inboxPath(vaultRoot, id), (raw) => {
          // A malformed file can still be rejected (removed); only the head is parsed.
          const h = parseProposalHead(id, raw.subarray(0, HEAD_BYTES).toString("utf8"));
          seen = { target: h?.target ?? "(malformed)" };
          return { message: `inbox reject: ${seen.target} (proposed by ${h?.proposedBy ?? "unknown"})` };
        });
        audit("inbox_reject", id, seen, "ok", "rejected", commitSha ?? undefined);
        res.json({ ok: true, id, target: seen.target, commit: commitSha });
      } catch (err) {
        if (err instanceof InboxMissingError) return void res.status(404).json({ error: "proposal not found" });
        audit("inbox_reject", id, seen, "error", redact(errorMessage(err)));
        throw err;
      }
    } catch (err) {
      next(err);
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
