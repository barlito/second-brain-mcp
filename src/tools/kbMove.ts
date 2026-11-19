import { readFileSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TokenContext } from "../auth/context";
import { checkScope } from "../acl/check";
import { assertSpaceLimits } from "../limits";
import { docsMapPaths, moveDocsMapEntry } from "../vault/docsMap";
import { MoveSourceDirtyError, MoveSourceMissingError, MoveTargetExistsError, syncMoveWithWrites } from "../vault/git";
import { createResolver, noteKey, NoteRef } from "../vault/links";
import { isValidSlug, resolveNotePath } from "../vault/paths";
import {
  auditedCall,
  Gate,
  INVALID_NAME,
  kbArgsShape,
  noteGate,
  NOTE_NOT_UTF8_MESSAGE,
  PERMISSION_DENIED,
  RegisterTool,
  registerKbTool,
  Target,
  toolError,
  toolText,
  ToolRunResult,
} from "./common";
import { ENTRY_NOTE, NoteRuleError, OVERVIEW_SECTION, validateNoteContent } from "./conventions";
import { normalizeNote, parseNote, utcToday } from "./frontmatter";
import { listReadableNotes, ScanBudget, scanNotice } from "./linkScan";
import { rewriteLinks } from "./moveLinks";
import { ARCHIVE_SECTION } from "./reserved";

const slugArg = kbArgsShape.section;

type Skip = "no write access" | "uncommitted changes" | "not UTF-8" | "limit";

interface MoveInfo {
  links: number;
  notes: number;
  notUpdated: Map<Skip, string[]>;
  docsMap?: string;
  scan: ScanBudget;
}

// A note to rewrite: link fixes and/or the Docs map change of the source project's index.
interface Edit {
  n: NoteRef;
  text: string;
  links: number;
  docs?: string;
}

export const SCAN_TRUNCATED_MESSAGE = "Too many notes to rewrite links safely; retry or use rewrite_links=false.";

// Destination: valid slugs, then write permission (generic message, like the source gate).
function destGate(to: Target): Gate {
  return (ctx) => {
    for (const field of ["space", "project", "section", "note"] as const) {
      if (!isValidSlug(to[field])) return { result: "error", message: INVALID_NAME, detail: `invalid destination ${field} slug` };
    }
    if (!checkScope(ctx.scopes, to.space, to.project, to.section, "write")) {
      return { result: "denied", message: PERMISSION_DENIED, detail: "no write on destination section" };
    }
    return undefined;
  };
}

const refuse = (message: string, detail: string): ToolRunResult => ({ toolResult: toolError(message), audit: { detail } });
const NO_MOVE_IN = new Set([OVERVIEW_SECTION, "journal"]);
const isEntryNote = (t: Target): boolean => t.section === OVERVIEW_SECTION && t.note === ENTRY_NOTE;
const ref = (t: Target): NoteRef => ({ space: t.space, project: t.project, section: t.section, name: t.note });
const pathOf = (t: Target): string => `${t.space}/${t.project}/${t.section}/${t.note}`;

function precheck(from: Target, to: Target): ToolRunResult | undefined {
  if (from.section === ARCHIVE_SECTION || to.section === ARCHIVE_SECTION) {
    return refuse("Section `archive` is managed by kb_archive; kb_move cannot move notes into or out of it.", "archive section");
  }
  if (isEntryNote(from)) return refuse("The project entry note (overview/index) cannot be moved.", "entry note");
  if (NO_MOVE_IN.has(to.section)) {
    return refuse(`Notes cannot be moved into \`${to.section}\` (overview and journal have their own rules).`, "destination section");
  }
  if (pathOf(from) === pathOf(to)) return refuse("Source and destination are the same note.", "same path");
  return undefined;
}

// The moved note in its destination section: a type that section refuses falls back to its default,
// as a kb_write of the body would do (author/updated change only when the frontmatter does).
function movedContent(original: string, section: string, author: string): string {
  let body: string;
  try {
    body = parseNote(original).body;
  } catch {
    return original; // malformed frontmatter: moved as-is
  }
  return normalizeNote(body, { section, author, today: utcToday(), existing: original });
}

function readUtf8(abs: string): string {
  const raw = readFileSync(abs);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) throw new NoteRuleError(NOTE_NOT_UTF8_MESSAGE, "not utf-8");
  return text;
}

const asTarget = (n: NoteRef): Target => ({ space: n.space, project: n.project, section: n.section, note: n.name });
const projectOf = (t: { space: string; project: string }): string => `${t.space}/${t.project}`;

// Links to the moved note, and links whose resolution the move changes, in the notes this token can read.
async function linkEdits(vaultRoot: string, ctx: TokenContext, from: Target, to: Target, moved: string, info: MoveInfo): Promise<{ moved: string; edits: Edit[] }> {
  const oldRef = ref(from);
  const newRef = ref(to);
  const notes = await listReadableNotes(vaultRoot, ctx.scopes, {}, false, info.scan);
  const resolveBefore = createResolver(notes);
  const resolveAfter = createResolver([...notes.filter((n) => noteKey(n) !== noteKey(oldRef)), newRef]);
  const retarget = (n: NoteRef): NoteRef => (noteKey(n) === noteKey(oldRef) ? newRef : n);
  const self = rewriteLinks(moved, { before: oldRef, after: newRef, resolveBefore, resolveAfter, retarget });
  info.links += self.links;
  if (self.links) info.notes++;
  const edits: Edit[] = [];
  for (const n of notes) {
    if (noteKey(n) === noteKey(oldRef)) continue;
    const content = await info.scan.read(n);
    if (content === undefined) {
      if (info.scan.truncated) break;
      continue;
    }
    const lower = content.toLowerCase();
    if (!lower.includes(from.note) && !lower.includes(to.note)) continue;
    const r = rewriteLinks(content, { before: n, after: n, resolveBefore, resolveAfter, retarget });
    if (r.links) edits.push({ n, text: r.text, links: r.links });
  }
  if (info.scan.truncated) throw new NoteRuleError(SCAN_TRUNCATED_MESSAGE, `scan truncated (${info.scan.truncated})`);
  return { moved: self.text, edits };
}

// Adds the Docs map change of the source project's index to `edits` (only when readable: never reveal it otherwise).
function docsMapEdit(vaultRoot: string, ctx: TokenContext, from: Target, to: Target, edits: Edit[], info: MoveInfo): void {
  const index: NoteRef = { space: from.space, project: from.project, section: OVERVIEW_SECTION, name: ENTRY_NOTE };
  if (!checkScope(ctx.scopes, index.space, index.project, index.section, "read")) return;
  const existing = edits.find((e) => noteKey(e.n) === noteKey(index));
  let current: string;
  try {
    current = existing?.text ?? readFileSync(resolveNotePath(vaultRoot, index.space, index.project, index.section, index.name), "utf8");
  } catch {
    return; // no index
  }
  const fromEntry = `${from.section}/${from.note}`;
  const edit =
    projectOf(from) === projectOf(to)
      ? moveDocsMapEntry(current, fromEntry, `${to.section}/${to.note}`)
      : docsMapPaths(current).includes(fromEntry)
        ? { change: `lists \`${fromEntry}\`, which moved to another project: update it by hand` }
        : undefined;
  if (!edit) return;
  if (edit.text === undefined) info.docsMap = edit.change;
  else if (existing) Object.assign(existing, { text: edit.text, docs: edit.change });
  else edits.push({ n: index, text: edit.text, links: 0, docs: edit.change });
}

async function runMove(vaultRoot: string, ctx: TokenContext, from: Target, to: Target, rewrite: boolean): Promise<ToolRunResult> {
  const fromAbs = resolveNotePath(vaultRoot, from.space, from.project, from.section, from.note);
  const toAbs = resolveNotePath(vaultRoot, to.space, to.project, to.section, to.note);
  const sameProject = projectOf(from) === projectOf(to);

  const { commitSha, info } = await syncMoveWithWrites<MoveInfo>(
    vaultRoot,
    fromAbs,
    toAbs,
    async (isDirty) => {
      const info: MoveInfo = { links: 0, notes: 0, notUpdated: new Map(), scan: new ScanBudget(vaultRoot) };
      const original = readUtf8(fromAbs);
      let moved = movedContent(original, to.section, ctx.name);
      let edits: Edit[] = [];
      if (rewrite) ({ moved, edits } = await linkEdits(vaultRoot, ctx, from, to, moved, info));
      docsMapEdit(vaultRoot, ctx, from, to, edits, info);

      // Only the moved note can refuse the move. Inside a project it replaces the source (no new note).
      const pending = new Map<string, number>();
      const movedBytes = Buffer.byteLength(moved, "utf8");
      assertSpaceLimits(vaultRoot, sameProject ? from : to, movedBytes);
      pending.set(projectOf(to), movedBytes - (sameProject ? Buffer.byteLength(original, "utf8") : 0));
      // A linking note that would break or grow past a limit is left alone; one that does not grow always passes.
      const withinLimits = (e: Edit, before: string): boolean => {
        const delta = Buffer.byteLength(e.text, "utf8") - Buffer.byteLength(before, "utf8");
        const p = projectOf(e.n);
        try {
          if (delta > 0) {
            validateNoteContent(asTarget(e.n), e.text);
            assertSpaceLimits(vaultRoot, asTarget(e.n), Buffer.byteLength(e.text, "utf8"), pending.get(p) ?? 0);
          }
        } catch (err) {
          if (err instanceof NoteRuleError) return false;
          throw err;
        }
        pending.set(p, (pending.get(p) ?? 0) + delta);
        return true;
      };

      const writes: Array<{ absolutePath: string; content: string }> = [];
      for (const e of edits) {
        const abs = resolveNotePath(vaultRoot, e.n.space, e.n.project, e.n.section, e.n.name);
        let before: string | undefined;
        try {
          before = readUtf8(abs);
        } catch {
          before = undefined;
        }
        const why: Skip | undefined = !checkScope(ctx.scopes, e.n.space, e.n.project, e.n.section, "write")
          ? "no write access"
          : (await isDirty(abs))
            ? "uncommitted changes"
            : before === undefined
              ? "not UTF-8"
              : !withinLimits(e, before)
                ? "limit"
                : undefined;
        if (why) {
          if (e.links) info.notUpdated.set(why, [...(info.notUpdated.get(why) ?? []), noteKey(e.n)]);
          if (e.docs) info.docsMap = `not updated (${why}): ${e.docs}`;
          continue;
        }
        writes.push({ absolutePath: abs, content: e.text });
        info.links += e.links;
        if (e.links) info.notes++;
        if (e.docs) info.docsMap = e.docs;
      }
      return { moved, writes, info };
    },
    `kb_move: ${pathOf(from)} -> ${pathOf(to)} via ${ctx.name}`,
  );

  const lines = [`Moved to ${pathOf(to)} (commit ${commitSha}).`];
  if (rewrite) lines.push(`Links rewritten: ${info.links} in ${info.notes} note(s).`);
  for (const [why, keys] of info.notUpdated) lines.push(`Linking notes not updated (${why}): ${keys.join(", ")}`);
  if (info.docsMap) lines.push(`Docs map of ${from.space}/${from.project}/overview/index: ${info.docsMap}`);
  const skipped = [...info.notUpdated.values()].reduce((a, k) => a + k.length, 0);
  const detail = `-> ${pathOf(to)} links=${info.links} notes=${info.notes}` + (skipped ? ` not_updated=${skipped}` : "");
  return { toolResult: toolText(lines.join("\n") + scanNotice(info.scan)), audit: { gitCommit: commitSha || undefined, detail } };
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_move",
    {
      description:
        "Rename or move a note and fix the wikilinks pointing to it, in one git commit. " +
        "Requires write on the source section AND on the destination section (to_space/to_project default to the source's). " +
        "A frontmatter type the destination section refuses becomes that section's default. " +
        "Links in the notes this token can read that point to the note (or whose target the move would change) are rewritten " +
        "(target only; heading, alias and embed kept) when the token can write them; others are listed as not updated. " +
        "The source project's Docs map entry is renamed or moved too. " +
        "Refused: the `archive` section (use kb_archive), overview/index as source, overview or journal as destination, " +
        "an existing destination, a source with uncommitted changes. Set rewrite_links=false to skip links (the Docs map is still updated).",
      inputSchema: {
        ...kbArgsShape,
        to_section: slugArg.describe("Destination section slug"),
        to_note: slugArg.describe("Destination note slug"),
        to_space: slugArg.optional().describe("Destination space (default: same)"),
        to_project: slugArg.optional().describe("Destination project (default: same)"),
        rewrite_links: z.boolean().optional().describe("Rewrite links to the note (default true)"),
      },
    },
    async ({ space, project, section, note, to_space, to_project, to_section, to_note, rewrite_links }): Promise<CallToolResult> => {
      const from: Target = { space, project, section, note };
      const to: Target = { space: to_space ?? space, project: to_project ?? project, section: to_section, note: to_note };
      const gate: Gate = (ctx) => noteGate(from, "write")(ctx) ?? destGate(to)(ctx);
      return auditedCall("kb_move", from, gate, async (ctx) => {
        const refused = precheck(from, to);
        if (refused) return refused;
        try {
          return await runMove(vaultRoot, ctx, from, to, rewrite_links !== false);
        } catch (err) {
          if (err instanceof MoveSourceMissingError) return refuse("Note not found.", "note not found");
          if (err instanceof MoveTargetExistsError) return refuse("Destination note already exists.", "destination exists");
          if (err instanceof MoveSourceDirtyError) {
            return refuse("Note has uncommitted changes in the vault; commit or discard them first.", "uncommitted changes");
          }
          if (err instanceof NoteRuleError) return refuse(err.message, err.detail);
          throw err;
        }
      });
    },
  );
};
