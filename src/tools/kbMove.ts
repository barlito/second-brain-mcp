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
import { hasFrontmatter, normalizeNote, parseNote, utcToday } from "./frontmatter";
import { listReadableNotes, ScanBudget, scanNotice } from "./linkScan";
import { rewriteLinks } from "./moveLinks";
import { ARCHIVE_SECTION } from "./reserved";

const slugArg = kbArgsShape.section;

interface MoveInfo {
  links: number;
  notes: number;
  noWrite: string[];
  dirty: string[];
  docsMap?: string;
  scan: ScanBudget;
}

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
const isEntryNote = (t: Target): boolean => t.section === OVERVIEW_SECTION && t.note === ENTRY_NOTE;
const ref = (t: Target): NoteRef => ({ space: t.space, project: t.project, section: t.section, name: t.note });
const pathOf = (t: Target): string => `${t.space}/${t.project}/${t.section}/${t.note}`;

function precheck(from: Target, to: Target): ToolRunResult | undefined {
  if (from.section === ARCHIVE_SECTION || to.section === ARCHIVE_SECTION) {
    return refuse("Section `archive` is managed by kb_archive; kb_move cannot move notes into or out of it.", "archive section");
  }
  if (isEntryNote(from) || isEntryNote(to)) {
    return refuse("The project entry note (overview/index) cannot be moved or replaced.", "entry note");
  }
  if (pathOf(from) === pathOf(to)) return refuse("Source and destination are the same note.", "same path");
  return undefined;
}

// The moved note in its destination section: a type that section refuses falls back to its default,
// as a kb_write of the body would do (author/updated change only when the frontmatter does).
function movedContent(original: string, section: string, author: string): string {
  if (!hasFrontmatter(section)) return original;
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

// Limits on every written note; `pending` carries the bytes earlier items add to each project.
function checkLimits(vaultRoot: string, items: Array<{ limitsAs: Target; target: Target; content: string; delta: number }>): void {
  const pending = new Map<string, number>();
  for (const it of items) {
    validateNoteContent(it.target, it.content);
    const project = `${it.limitsAs.space}/${it.limitsAs.project}`;
    assertSpaceLimits(vaultRoot, it.limitsAs, Buffer.byteLength(it.content, "utf8"), pending.get(project) ?? 0);
    pending.set(project, (pending.get(project) ?? 0) + it.delta);
  }
}

async function runMove(vaultRoot: string, ctx: TokenContext, from: Target, to: Target, rewrite: boolean): Promise<ToolRunResult> {
  const fromAbs = resolveNotePath(vaultRoot, from.space, from.project, from.section, from.note);
  const toAbs = resolveNotePath(vaultRoot, to.space, to.project, to.section, to.note);
  const oldRef = ref(from);
  const newRef = ref(to);
  const canWrite = (n: NoteRef): boolean => checkScope(ctx.scopes, n.space, n.project, n.section, "write");

  const { commitSha, info } = await syncMoveWithWrites<MoveInfo>(
    vaultRoot,
    fromAbs,
    toAbs,
    async (isDirty) => {
      const original = readUtf8(fromAbs);
      let moved = movedContent(original, to.section, ctx.name);
      const info: MoveInfo = { links: 0, notes: 0, noWrite: [], dirty: [], scan: new ScanBudget(vaultRoot) };
      // Rewritten notes by key, in scan order.
      const edits = new Map<string, { n: NoteRef; text: string; before: string }>();
      const skip = async (n: NoteRef, abs: string): Promise<"noWrite" | "dirty" | undefined> =>
        !canWrite(n) ? "noWrite" : (await isDirty(abs)) ? "dirty" : undefined;

      const notes = rewrite ? await listReadableNotes(vaultRoot, ctx.scopes, {}, false, info.scan) : [];
      if (rewrite) {
        const resolveBefore = createResolver(notes);
        const resolveAfter = createResolver([...notes.filter((n) => noteKey(n) !== noteKey(oldRef)), newRef]);
        const self = rewriteLinks(moved, { before: oldRef, after: newRef, resolveBefore, resolveAfter, retarget: (n) => (noteKey(n) === noteKey(oldRef) ? newRef : n) });
        moved = self.text;
        if (self.links) {
          info.links += self.links;
          info.notes++;
        }
        const retarget = (n: NoteRef) => (noteKey(n) === noteKey(oldRef) ? newRef : undefined);
        for (const n of notes) {
          if (noteKey(n) === noteKey(oldRef)) continue;
          const content = await info.scan.read(n);
          if (content === undefined) {
            if (info.scan.truncated) break;
            continue;
          }
          if (!content.toLowerCase().includes(from.note)) continue;
          const r = rewriteLinks(content, { before: n, after: n, resolveBefore, resolveAfter, retarget });
          if (!r.links) continue;
          const why = await skip(n, resolveNotePath(vaultRoot, n.space, n.project, n.section, n.name));
          if (why) {
            info[why].push(noteKey(n));
            continue;
          }
          edits.set(noteKey(n), { n, text: r.text, before: content });
          info.links += r.links;
          info.notes++;
        }
      }

      // Docs map of the source project's entry note (only when readable: never reveal it otherwise).
      const index: NoteRef = { space: from.space, project: from.project, section: OVERVIEW_SECTION, name: ENTRY_NOTE };
      if (checkScope(ctx.scopes, index.space, index.project, index.section, "read")) {
        const indexAbs = resolveNotePath(vaultRoot, index.space, index.project, index.section, index.name);
        let current: string | undefined;
        try {
          current = edits.get(noteKey(index))?.text ?? readUtf8(indexAbs);
        } catch {
          current = undefined; // missing or not UTF-8
        }
        const fromEntry = `${from.section}/${from.note}`;
        if (current !== undefined) {
          const sameProject = from.space === to.space && from.project === to.project;
          const edit = sameProject
            ? moveDocsMapEntry(current, fromEntry, `${to.section}/${to.note}`)
            : docsMapPaths(current).includes(fromEntry)
              ? { change: `lists \`${fromEntry}\`, which moved to another project: update it by hand` }
              : undefined;
          if (edit?.text !== undefined) {
            const why = edits.has(noteKey(index)) ? undefined : await skip(index, indexAbs);
            if (why) info.docsMap = `not updated (${why === "noWrite" ? "no write access" : "uncommitted changes"}): ${edit.change}`;
            else {
              edits.set(noteKey(index), { n: index, text: edit.text, before: edits.get(noteKey(index))?.before ?? current });
              info.docsMap = edit.change;
            }
          } else if (edit) info.docsMap = edit.change;
        }
      }

      const asTarget = (n: NoteRef): Target => ({ space: n.space, project: n.project, section: n.section, note: n.name });
      const sameProject = from.space === to.space && from.project === to.project;
      checkLimits(vaultRoot, [
        // A move inside a project replaces the source (no new note); across projects it adds one to the destination.
        { limitsAs: sameProject ? from : to, target: to, content: moved, delta: Buffer.byteLength(moved) - (sameProject ? Buffer.byteLength(original) : 0) },
        ...[...edits.values()].map((e) => ({
          limitsAs: asTarget(e.n),
          target: asTarget(e.n),
          content: e.text,
          delta: Buffer.byteLength(e.text) - Buffer.byteLength(e.before),
        })),
      ]);
      const writes = [...edits.values()].map((e) => ({
        absolutePath: resolveNotePath(vaultRoot, e.n.space, e.n.project, e.n.section, e.n.name),
        content: e.text,
      }));
      return { moved, writes, info };
    },
    `kb_move: ${pathOf(from)} -> ${pathOf(to)} via ${ctx.name}`,
  );

  const lines = [`Moved to ${pathOf(to)} (commit ${commitSha}).`];
  if (rewrite) lines.push(`Links rewritten: ${info.links} in ${info.notes} note(s).`);
  if (info.noWrite.length) lines.push(`Linking notes not updated (no write access): ${info.noWrite.join(", ")}`);
  if (info.dirty.length) lines.push(`Linking notes not updated (uncommitted changes): ${info.dirty.join(", ")}`);
  if (info.docsMap) lines.push(`Docs map of ${from.space}/${from.project}/overview/index: ${info.docsMap}`);
  const detail =
    `-> ${pathOf(to)} links=${info.links} notes=${info.notes}` +
    (info.noWrite.length + info.dirty.length ? ` not_updated=${info.noWrite.length + info.dirty.length}` : "") +
    (info.scan.truncated ? ` truncated(${info.scan.truncated})` : "");
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
        "Links to the note from notes this token can read are rewritten (target only; heading, alias and embed kept) " +
        "when the token can write them; others are listed as not updated. The source project's Docs map entry is renamed or moved too. " +
        "Refused: the `archive` section (use kb_archive), overview/index as source or destination, an existing destination, " +
        "a source with uncommitted changes. Set rewrite_links=false to only move (the Docs map is still updated).",
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
