// Vault operations for the web admin (browse, edit, create, archive, history). No HTTP here.
// Every write goes through syncWrite/syncMove, i.e. the same serialized lock + commit path
// as the MCP tools. Failures mapping to a client status are thrown as AdminError.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listNoteNames, listSubdirs, NoteInfo, readFileNoFollow, statNote } from "../vault/enumerate";
import { isValidSlug, resolveNotePath, UnsafePathError } from "../vault/paths";
import { NoteExistsError, noteHistory, NoteHistoryEntry, runGit, syncWriteBuilt } from "../vault/git";
import { normalizeNote, utcToday } from "../tools/frontmatter";
import { MAX_CONTENT_CHARS } from "../tools/common";
import { NoteRuleError, validateNoteContent } from "../tools/conventions";
import { assertSpaceLimits } from "../limits";
import { archiveNote } from "../tools/archiveNote";
import { ARCHIVE_SECTION } from "../tools/reserved";
import { AdminError } from "./service";

export interface NoteRef {
  space: string;
  project: string;
  section: string;
  note: string;
}

export const STALE_MESSAGE = "note changed since you opened it";
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SHOW_CHARS = 1024 * 1024;
const HISTORY_LIMIT = 100;
const MAX_HISTORY_SCAN = 5000;
export const HASH_RE = /^[0-9a-f]{40}$/;
export const NOT_UTF8_MESSAGE = "note is not valid UTF-8, edit it in git";
const SHA256_RE = /^[0-9a-f]{64}$/;

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Text as served to the edit form: CRLF-only files are shown with LF (the browser submits LF
// anyway); the base hash is over this text. `crlf` = every newline is CRLF, restored on write.
function formView(content: string): { text: string; crlf: boolean } {
  const crlf = content.includes("\r\n") && !/(^|[^\r])\n/.test(content);
  return { text: crlf ? content.replace(/\r\n/g, "\n") : content, crlf };
}

// Unsafe paths (symlinks etc.) look like "not found" to the client.
function resolve(vaultRoot: string, t: NoteRef): string {
  try {
    return resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note);
  } catch (err) {
    if (err instanceof UnsafePathError) throw new AdminError(404, "not found");
    throw err;
  }
}

// ---- browse ----

export type Listing =
  | { kind: "dirs"; names: string[] }
  | { kind: "notes"; notes: NoteInfo[] };

// parts = [] (spaces) .. [space, project, section] (notes). Every level must exist.
export async function browse(vaultRoot: string, parts: string[]): Promise<Listing> {
  try {
    for (let i = 0; i < parts.length; i++) {
      if (!(await listSubdirs(vaultRoot, parts.slice(0, i))).includes(parts[i])) throw new AdminError(404, "not found");
    }
    if (parts.length < 3) return { kind: "dirs", names: await listSubdirs(vaultRoot, parts) };
    const names = await listNoteNames(vaultRoot, parts);
    const notes = (await Promise.all(names.map((n) => statNote(vaultRoot, parts, n)))).filter((n): n is NoteInfo => !!n);
    return { kind: "notes", notes };
  } catch (err) {
    if (err instanceof UnsafePathError) throw new AdminError(404, "not found");
    throw err;
  }
}

// ---- read ----

export interface ShownNote {
  content: string;
  size: number;
  hash: string; // of `formText`
  formText: string;
  last: NoteHistoryEntry | null;
  writable: boolean;
  editable: boolean; // false when the bytes do not round-trip as UTF-8
}

export async function showNote(vaultRoot: string, t: NoteRef): Promise<ShownNote> {
  const abs = resolve(vaultRoot, t);
  let r;
  try {
    r = await readFileNoFollow(abs, MAX_READ_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") throw new AdminError(404, "note not found");
    throw err;
  }
  if (!r) throw new AdminError(413, "note too large to show");
  const { entries } = await noteHistory(vaultRoot, abs, 1);
  const { text } = formView(r.content);
  const editable = Buffer.from(r.content, "utf8").equals(r.raw);
  return { content: r.content, size: r.bytes, hash: sha256Hex(text), formText: text, last: entries[0] ?? null, writable: t.section !== ARCHIVE_SECTION, editable };
}

// ---- write ----

// Same rules as kb_write: reserved section, size cap, entry-note cap.
function checkContent(t: NoteRef, content: string): void {
  if (t.section === ARCHIVE_SECTION) throw new AdminError(422, "Section `archive` is managed by archiving and cannot be written directly.");
  if (content.length > MAX_CONTENT_CHARS) throw new AdminError(422, "content too large (max 512 KB)");
  try {
    validateNoteContent(t, content);
  } catch (err) {
    if (err instanceof NoteRuleError) throw new AdminError(422, err.message);
    throw err;
  }
}

// Frontmatter rules, run inside the write lock on the note's current bytes. Author = the audit
// actor of web writes (web:<user>). Errors become 422 for the form.
function withFrontmatter(t: NoteRef, user: string, content: string, previous: Buffer | null): string {
  const raw = previous ? previous.toString("utf8") : null;
  const { text, crlf } = raw === null ? { text: null, crlf: false } : formView(raw);
  try {
    const out = normalizeNote(content, { section: t.section, author: `web:${user}`, today: utcToday(), existing: text });
    if (out === text) return raw as string; // unchanged: keep the file byte for byte
    return crlf ? out.replace(/\n/g, "\r\n") : out;
  } catch (err) {
    if (err instanceof NoteRuleError) throw new AdminError(422, err.message);
    throw err;
  }
}

// Optimistic concurrency: `base` is the sha256 of the content the form was loaded from. The
// comparison runs INSIDE the write lock (after the pull), so nothing can slip in between
// the check and the write.
// Returns null when the content was identical (nothing committed).
export async function editNote(vaultRoot: string, t: NoteRef, content: string, base: string, user: string): Promise<string | null> {
  if (!SHA256_RE.test(base)) throw new AdminError(422, "missing or invalid form state; reload the note");
  checkContent(t, content);
  const abs = resolve(vaultRoot, t);
  const read = async (): Promise<{ text: string; crlf: boolean; utf8: boolean } | undefined> => {
    try {
      const cur = await readFileNoFollow(abs, MAX_READ_BYTES);
      return cur && { ...formView(cur.content), utf8: Buffer.from(cur.content, "utf8").equals(cur.raw) };
    } catch {
      return undefined;
    }
  };
  const before = await read();
  if (before && !before.utf8) throw new AdminError(422, NOT_UTF8_MESSAGE);
  let commitSha: string | null;
  let previous: Buffer | null = null;
  try {
    ({ commitSha } = await syncWriteBuilt(vaultRoot, abs, (prev) => ((previous = prev), withFrontmatter(t, user, content, prev)), `web: edit ${t.space}/${t.project}/${t.section}/${t.note} by ${user}`, {
      // Stale check first (409), limits after on the final bytes (422).
      precheck: async () => {
        const cur = await read();
        if (!cur || sha256Hex(cur.text) !== base || cur.crlf !== before?.crlf) throw new AdminError(409, STALE_MESSAGE);
        if (!cur.utf8) throw new AdminError(422, NOT_UTF8_MESSAGE);
      },
      // An unchanged save of an over-limit note is "no changes", not a limit error.
      check: (next) => {
        if (previous?.equals(Buffer.from(next, "utf8"))) return;
        assertSpaceLimits(vaultRoot, t, Buffer.byteLength(next, "utf8"));
      },
    }));
  } catch (err) {
    if (err instanceof NoteRuleError) throw new AdminError(422, err.message);
    throw err;
  }
  return commitSha;
}

export async function createNote(vaultRoot: string, t: NoteRef, content: string, user: string): Promise<string | null> {
  if (!isValidSlug(t.note)) throw new AdminError(422, "Invalid note name: use a-z, 0-9 and hyphens (max 64, no leading hyphen).");
  checkContent(t, content);
  const abs = resolve(vaultRoot, t);
  try {
    const { commitSha } = await syncWriteBuilt(vaultRoot, abs, (prev) => withFrontmatter(t, user, content, prev), `web: create ${t.space}/${t.project}/${t.section}/${t.note} by ${user}`, {
      mustNotExist: true,
      check: (next) => assertSpaceLimits(vaultRoot, t, Buffer.byteLength(next, "utf8")),
    });
    return commitSha;
  } catch (err) {
    if (err instanceof NoteRuleError) throw new AdminError(422, err.message);
    if (err instanceof NoteExistsError) throw new AdminError(409, "a note with this name already exists");
    throw err;
  }
}

// Reuses the kb_archive implementation (archiveNote).
export async function archiveWebNote(vaultRoot: string, t: NoteRef, user: string): Promise<{ name: string; commitSha: string }> {
  try {
    const r = await archiveNote(vaultRoot, t, `web: archive ${t.space}/${t.project}/${t.section}/${t.note} by ${user}`);
    if (!r.ok) throw new AdminError(r.message === "Note not found." ? 404 : 422, r.message);
    return r;
  } catch (err) {
    if (err instanceof UnsafePathError) throw new AdminError(404, "not found");
    throw err;
  }
}

// ---- history ----

export async function noteLog(vaultRoot: string, t: NoteRef): Promise<NoteHistoryEntry[]> {
  const abs = resolve(vaultRoot, t);
  const { entries } = await noteHistory(vaultRoot, abs, HISTORY_LIMIT);
  if (entries.length === 0) {
    try {
      readFileSync(abs);
    } catch {
      throw new AdminError(404, "note not found");
    }
  }
  return entries;
}

// `hash` must already match HASH_RE (40 hex, so it can never be read as an option). The path is
// never taken from the client: it must be the one noteHistory reports for that exact commit
// (it differs from the current path for notes renamed/archived since).
export async function noteAt(vaultRoot: string, t: NoteRef, hash: string, atPath?: string): Promise<{ content: string; truncated: boolean; utf8: boolean }> {
  if (!HASH_RE.test(hash)) throw new AdminError(404, "not found");
  const abs = resolve(vaultRoot, t);
  const { entries } = await noteHistory(vaultRoot, abs, MAX_HISTORY_SCAN);
  const e = entries.find((x) => x.hash === hash);
  if (!e || (atPath !== undefined && atPath !== e.path)) throw new AdminError(404, "note not found at this commit");
  let out: string;
  let utf8 = true;
  try {
    out = await runGit(["show", `${hash}:./${e.path}`], vaultRoot);
    // Decoding invalid bytes yields U+FFFD (3 bytes): a size mismatch with the blob means it was lossy.
    if (out.includes("\uFFFD")) {
      const size = Number((await runGit(["cat-file", "-s", `${hash}:./${e.path}`], vaultRoot)).trim());
      utf8 = Buffer.byteLength(out, "utf8") === size;
    }
  } catch {
    throw new AdminError(404, "note not found at this commit");
  }
  return out.length > MAX_SHOW_CHARS ? { content: out.slice(0, MAX_SHOW_CHARS), truncated: true, utf8 } : { content: out, truncated: false, utf8 };
}

// Unified diff from the version at commit `hash` to the current one (hunks only, git's own output).
export async function noteDiff(vaultRoot: string, t: NoteRef, hash: string): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  if (!HASH_RE.test(hash)) throw new AdminError(404, "not found");
  const abs = resolve(vaultRoot, t);
  const { entries } = await noteHistory(vaultRoot, abs, MAX_HISTORY_SCAN);
  const e = entries.find((x) => x.hash === hash);
  if (!e) throw new AdminError(404, "note not found at this commit");
  let out: string;
  try {
    // Both operands start with a sha or HEAD, so neither can be read as an option.
    out = await runGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", `${hash}:./${e.path}`, `HEAD:./${t.space}/${t.project}/${t.section}/${t.note}.md`, "--"], vaultRoot);
  } catch {
    throw new AdminError(404, "note not found at this commit");
  }
  const at = out.indexOf("\n@@");
  const hunks = at < 0 ? "" : out.slice(at + 1);
  // Output without any hunk: git reports a binary/non-text change.
  const binary = at < 0 && out.trim() !== "";
  return hunks.length > MAX_SHOW_CHARS ? { diff: hunks.slice(0, MAX_SHOW_CHARS), truncated: true, binary } : { diff: hunks, truncated: false, binary };
}

// Hash (as the edit form's `base`) of the note as it is now, or undefined when it cannot be read.
export async function currentBase(vaultRoot: string, t: NoteRef): Promise<string | undefined> {
  try {
    const cur = await readFileNoFollow(resolve(vaultRoot, t), MAX_READ_BYTES);
    return cur ? sha256Hex(formView(cur.content).text) : undefined;
  } catch {
    return undefined;
  }
}

// Writes the version at commit `hash` as the new current content, through the same rules as a
// web edit. `base` = hash of the current note when the page was rendered (409 if it changed).
// Returns null when it is identical to the current note (nothing committed).
export async function restoreNote(vaultRoot: string, t: NoteRef, hash: string, base: string, user: string): Promise<string | null> {
  if (!SHA256_RE.test(base)) throw new AdminError(422, "missing or invalid form state; reload the page");
  const old = await noteAt(vaultRoot, t, hash);
  if (old.truncated) throw new AdminError(422, "that version is too large to restore");
  if (!old.utf8) throw new AdminError(422, "that version is not valid UTF-8 and cannot be restored here");
  const content = old.content.replace(/\r\n?/g, "\n");
  checkContent(t, content);
  const abs = resolve(vaultRoot, t);
  let previous: Buffer | null = null;
  try {
    const { commitSha } = await syncWriteBuilt(vaultRoot, abs, (prev) => ((previous = prev), withFrontmatter(t, user, content, prev)), `web restore: ${t.space}/${t.project}/${t.section}/${t.note} to ${hash.slice(0, 7)} by ${user}`, {
      precheck: async () => {
        let cur;
        try {
          cur = await readFileNoFollow(abs, MAX_READ_BYTES);
        } catch {
          throw new AdminError(404, "note not found");
        }
        if (!cur) throw new AdminError(404, "note not found");
        if (sha256Hex(formView(cur.content).text) !== base) throw new AdminError(409, STALE_MESSAGE);
        if (!Buffer.from(cur.content, "utf8").equals(cur.raw)) throw new AdminError(422, NOT_UTF8_MESSAGE);
      },
      check: (next) => {
        if (previous?.equals(Buffer.from(next, "utf8"))) return;
        assertSpaceLimits(vaultRoot, t, Buffer.byteLength(next, "utf8"));
      },
    });
    return commitSha;
  } catch (err) {
    if (err instanceof NoteRuleError) throw new AdminError(422, err.message);
    throw err;
  }
}
