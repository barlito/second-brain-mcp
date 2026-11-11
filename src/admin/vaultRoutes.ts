// /vault routes of the web admin. Mounted by web.ts, which already enforced identity and, for
// POSTs, Origin + CSRF + one-time nonce. Slugs and hashes are validated before any FS access.
import express, { Request, Response } from "express";
import { clientMessage, safeAudit } from "../tools/common";
import { isValidSlug } from "../vault/paths";
import { SyncConflictError, VaultBusyError } from "../vault/git";
import type { SafeHtml } from "../web/html";
import { Banner, Ctx, errorView } from "../web/views";
import { atView, browseView, editView, historyView, newView, noteView } from "../web/vaultViews";
import { AdminError } from "./service";
import { archiveWebNote, browse, createNote, editNote, HASH_RE, noteAt, noteLog, NoteRef, showNote } from "./vault";

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
    await browse(vaultRoot, [t.space, t.project, t.section]);
    try {
      const sha = await createNote(vaultRoot, t, content, userOf(res));
      auditWrite(res, "web_note_create", t, "ok", "created", sha);
      d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `Created ${t.note}.`, lines: [`Commit ${sha.slice(0, 7)}`] });
    } catch (err) {
      if (err instanceof AdminError && (err.status === 422 || err.status === 409)) {
        auditWrite(res, "web_note_create", t, "error", err.message);
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
    send(res, editView(ctxOf(res), t, n.content, n.hash));
  }));
  r.post("/:space/:project/:section/:note/edit", h(async (req, res) => {
    const t = refOf(req);
    const body = req.body as Record<string, unknown>;
    const content = str(body.content).replace(/\r\n?/g, "\n");
    const base = str(body.base);
    try {
      const sha = await editNote(vaultRoot, t, content, base, userOf(res));
      auditWrite(res, "web_note_edit", t, "ok", "edited", sha);
      d.redirectBanner(res, noteUrl(t), { kind: "ok", title: `Saved ${t.note}.`, lines: [`Commit ${sha.slice(0, 7)}`] });
    } catch (err) {
      if (err instanceof AdminError) auditWrite(res, "web_note_edit", t, "error", err.message);
      // 422: rule violation; keep the user's text in the form. 409 (stale) and the rest: error page.
      if (err instanceof AdminError && err.status === 422) {
        return send(res, editView(ctxOf(res), t, content, base, { kind: "err", title: err.message }), 422);
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
      if (err instanceof AdminError) {
        auditWrite(res, "web_note_archive", t, "error", err.message);
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
    send(res, atView(ctxOf(res), t, hash, await noteAt(vaultRoot, t, hash)));
  }));

  return r;
}

