// /vault routes of the web admin. Mounted by web.ts, which already enforced identity and, for
// POSTs, Origin + CSRF + one-time nonce. Slugs and hashes are validated before any FS access.
import express, { Request, Response } from "express";
import { clientMessage, safeAudit } from "../tools/common";
import { isValidSlug } from "../vault/paths";
import { ARCHIVE_SECTION } from "../tools/reserved";
import { SyncConflictError, VaultBusyError } from "../vault/git";
import type { SafeHtml } from "../web/html";
import { Banner, Ctx, errorView } from "../web/views";
import { atView, browseView, diffView, editView, historyView, newView, noteView } from "../web/vaultViews";
import { AdminError } from "./service";
import { archiveWebNote, browse, createNote, editNote, HASH_RE, NOT_UTF8_MESSAGE, noteAt, noteDiff, noteLog, NoteRef, restoreNote, showNote } from "./vault";

export interface VaultDeps {
  vaultRoot: string;
  ctxOf: (res: Response) => Ctx;
  send: (res: Response, view: SafeHtml, status?: number) => void;
  takeBanner: (req: Request, res: Response) => Banner | undefined;
  redirectBanner: (res: Response, to: string, banner: Banner) => void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SLUG_PARAMS = ["space", "project", "section", "note"] as const;

export function vaultRouter(d: VaultDeps): express.Router {
  const r = express.Router();
  const { vaultRoot, ctxOf, send } = d;

  for (const p of SLUG_PARAMS) {
    r.param(p, (_req, res, next, v: string) => {
      if (!isValidSlug(v)) return void send(res, errorView(ctxOf(res), 400, `invalid ${p} name`), 400);
      next();
    });
  }
  r.param("hash", (_req, res, next, v: string) => {
    if (!HASH_RE.test(v)) return void send(res, errorView(ctxOf(res), 400, "invalid commit hash"), 400);
    next();
  });

  const refOf = (req: Request): NoteRef => {
    const p = req.params as Record<string, string>;
    return { space: p.space, project: p.project, section: p.section, note: p.note };
  };
  const dirOf = (t: NoteRef): string => `/vault/${t.space}/${t.project}/${t.section}`;
  const noteUrl = (t: NoteRef): string => `${dirOf(t)}/${t.note}`;

  // Every web write gets an audit row, actor web:<user>.
  const auditWrite = (res: Response, action: string, t: NoteRef, result: "ok" | "error", detail: string, gitCommit?: string): void => {
    const actor = `web:${res.locals.user as string}`;
    safeAudit({ tokenId: actor, tokenName: actor, action, ...t, result, detail, gitCommit }, actor);
  };
  const reasonOf = (err: unknown): string => (err instanceof AdminError ? err.message : clientMessage(err));
  const userOf = (res: Response): string => res.locals.user as string;

  // Maps a failure to an error page; anything unexpected goes to the generic 500 handler.
  const fail = (res: Response, err: unknown): void => {
    if (err instanceof AdminError) return send(res, errorView(ctxOf(res), err.status, err.message), err.status);
    if (err instanceof SyncConflictError) return send(res, errorView(ctxOf(res), 409, clientMessage(err)), 409);
    if (err instanceof VaultBusyError) return send(res, errorView(ctxOf(res), 503, clientMessage(err)), 503);
    throw err;
  };
  // Wraps a handler so thrown AdminErrors become pages.
  const h =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  // ---- browse ----
  const listing = h(async (req, res) => {
    const p = req.params as Record<string, string>;
    const parts = SLUG_PARAMS.slice(0, 3).map((k) => p[k]).filter((v) => v !== undefined);
    send(res, browseView(ctxOf(res), parts, await browse(vaultRoot, parts), d.takeBanner(req, res)));
  });
  r.get("/", listing);
  r.get("/:space", listing);
  r.get("/:space/:project", listing);
  r.get("/:space/:project/:section", listing);

  // ---- create (the "_new" segment cannot clash with a slug) ----
  const newPage = (res: Response, t: NoteRef, content: string, banner?: Banner, status = 200): void =>
    send(res, newView(ctxOf(res), t, t.note, content, banner), status);

  r.get("/:space/:project/:section/_new", h(async (req, res) => {
    const t = { ...refOf(req), note: "" };
    await browse(vaultRoot, [t.space, t.project, t.section]); // 404 unless the section exists
    newPage(res, t, "");
  }));
  r.post("/:space/:project/:section/_new", h(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const t = { ...refOf(req), note: str(body.note) };
    const content = str(body.content).replace(/\r\n?/g, "\n");
    try {
      await browse(vaultRoot, [t.space, t.project, t.section]);
      const sha = await createNote(vaultRoot, t, content, userOf(res));
      auditWrite(res, "web_note_create", t, "ok", "created", sha || undefined);
      d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `Created ${t.note}.`, lines: sha ? [`Commit ${sha.slice(0, 7)}`] : [] });
    } catch (err) {
      auditWrite(res, "web_note_create", t, "error", reasonOf(err));
      if (err instanceof AdminError && (err.status === 422 || err.status === 409)) {
        return newPage(res, t, content, { kind: "err", title: err.message }, err.status);
      }
      throw err;
    }
  }));

  // ---- note ----
  r.get("/:space/:project/:section/:note", h(async (req, res) => {
    const t = refOf(req);
    const n = await showNote(vaultRoot, t);
    send(res, noteView(ctxOf(res), t, n, req.query.view === "raw" ? "raw" : "rendered", d.takeBanner(req, res)));
  }));

  r.get("/:space/:project/:section/:note/edit", h(async (req, res) => {
    const t = refOf(req);
    const n = await showNote(vaultRoot, t);
    if (!n.writable) throw new AdminError(422, "Archived notes are read-only.");
    if (!n.editable) throw new AdminError(422, NOT_UTF8_MESSAGE);
    send(res, editView(ctxOf(res), t, n.formText, n.hash));
  }));
  r.post("/:space/:project/:section/:note/edit", h(async (req, res) => {
    const t = refOf(req);
    const body = req.body as Record<string, unknown>;
    const content = str(body.content).replace(/\r\n?/g, "\n");
    const base = str(body.base);
    try {
      const sha = await editNote(vaultRoot, t, content, base, userOf(res));
      if (sha === null) {
        // Identical content: no commit, so no sha (HEAD may be someone else's commit).
        auditWrite(res, "web_note_edit", t, "ok", "no changes (content identical)");
        d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `No changes to ${t.note} (content identical).` });
      } else {
        auditWrite(res, "web_note_edit", t, "ok", "edited", sha || undefined);
        d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `Saved ${t.note}.`, lines: sha ? [`Commit ${sha.slice(0, 7)}`] : [] });
      }
    } catch (err) {
      auditWrite(res, "web_note_edit", t, "error", reasonOf(err));
      // 422 (rule violation) and 409 (stale): keep the user's text and the ORIGINAL base, so a
      // resave is still refused. Not-UTF-8 and the rest: error page.
      if (err instanceof AdminError && err.status === 422 && err.message !== NOT_UTF8_MESSAGE) {
        return send(res, editView(ctxOf(res), t, content, base, { kind: "err", title: err.message }), 422);
      }
      if (err instanceof AdminError && err.status === 409) {
        return send(res, editView(ctxOf(res), t, content, base, { kind: "err", title: err.message }, true), 409);
      }
      throw err;
    }
  }));

  r.post("/:space/:project/:section/:note/archive", h(async (req, res) => {
    const t = refOf(req);
    try {
      const a = await archiveWebNote(vaultRoot, t, userOf(res));
      auditWrite(res, "web_note_archive", t, "ok", `-> archive/${a.name}`, a.commitSha || undefined);
      d.redirectBanner(res, dirOf(t), { kind: "ok", title: `Archived ${t.note} to archive/${a.name}.` });
    } catch (err) {
      auditWrite(res, "web_note_archive", t, "error", reasonOf(err));
      if (err instanceof AdminError) {
        return d.redirectBanner(res, err.status === 404 ? dirOf(t) : noteUrl(t), { kind: "err", title: err.message });
      }
      throw err;
    }
  }));

  // ---- history ----
  r.get("/:space/:project/:section/:note/history", h(async (req, res) => {
    const t = refOf(req);
    send(res, historyView(ctxOf(res), t, await noteLog(vaultRoot, t)));
  }));
  r.get("/:space/:project/:section/:note/at/:hash", h(async (req, res) => {
    const t = refOf(req);
    const hash = req.params.hash as string;
    send(res, atView(ctxOf(res), t, hash, t.section !== ARCHIVE_SECTION, await noteAt(vaultRoot, t, hash, typeof req.query.path === "string" ? req.query.path : undefined)));
  }));

  r.get("/:space/:project/:section/:note/at/:hash/diff", h(async (req, res) => {
    const t = refOf(req);
    const hash = req.params.hash as string;
    send(res, diffView(ctxOf(res), t, hash, t.section !== ARCHIVE_SECTION, await noteDiff(vaultRoot, t, hash), d.takeBanner(req, res)));
  }));
  r.post("/:space/:project/:section/:note/at/:hash/restore", h(async (req, res) => {
    const t = refOf(req);
    const hash = req.params.hash as string;
    const short = hash.slice(0, 7);
    try {
      const sha = await restoreNote(vaultRoot, t, hash, userOf(res));
      if (sha === null) {
        auditWrite(res, "web_note_restore", t, "ok", `restore to ${short}: no changes (content identical)`);
        d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `No changes to ${t.note} (content identical to ${short}).` });
      } else {
        auditWrite(res, "web_note_restore", t, "ok", `restored to ${short}`, sha || undefined);
        d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `Restored ${t.note} to ${short}.`, lines: sha ? [`Commit ${sha.slice(0, 7)}`] : [] });
      }
    } catch (err) {
      auditWrite(res, "web_note_restore", t, "error", reasonOf(err));
      if (err instanceof AdminError) {
        return d.redirectBanner(res, err.status === 404 ? dirOf(t) : noteUrl(t), { kind: "err", title: err.message });
      }
      throw err;
    }
  }));

  return r;
}

