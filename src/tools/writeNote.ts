import { resolveNotePath } from "../vault/paths";
import { NoteExistsError, syncWriteBuilt } from "../vault/git";
import { noteVersion } from "../vault/noteVersion";
import { MAX_CONTENT_CHARS, NO_CHANGES_MESSAGE, NOTE_NOT_UTF8_MESSAGE, toolError, toolText, ToolRunResult } from "./common";
import { assertNoSecret, NoteRuleError, validateNoteContent } from "./conventions";
import { assertSpaceLimits, SpaceLimitError } from "../limits";
import { normalizeNote, searchView, utcToday } from "./frontmatter";

// kb_write refuses to replace a body of at least MIN bytes by one smaller than RATIO of it.
export const SHRINK_GUARD_MIN_BODY_BYTES = 1024;
export const SHRINK_GUARD_RATIO = 0.5;

const conflict = (message: string, detail: string): NoteRuleError => new NoteRuleError(message, detail);

function assertBaseVersion(base: string, prev: Buffer | null): void {
  if (prev === null) throw conflict("Conflict: the note no longer exists.", "conflict: note missing");
  const current = noteVersion(prev);
  if (current !== base) {
    throw conflict(
      `Conflict: the note changed since you read it (current version ${current}). Re-read it, merge your changes and retry.`,
      "conflict: base_version mismatch",
    );
  }
}

function assertNoShrink(section: string, prev: string, next: string): void {
  const before = Buffer.byteLength(searchView(section, prev).body, "utf8");
  const after = Buffer.byteLength(searchView(section, next).body, "utf8");
  if (before >= SHRINK_GUARD_MIN_BODY_BYTES && after < before * SHRINK_GUARD_RATIO) {
    throw new NoteRuleError(
      `This write would shrink the note body from ${before} to ${after} bytes. ` +
        "To change part of a note use kb_edit; if condensing is intended, retry with allow_shrink: true.",
      `shrink guard (${before} -> ${after} bytes)`,
    );
  }
}

// Shared write path (kb_write, kb_init_project): content rules, then path
// resolution, then the locked write. Call after the ACL check.
export async function writeNote(
  vaultRoot: string,
  target: { space: string; project: string; section: string; note: string },
  // A function builds the content inside the lock from the current note text (null = missing), e.g. kb_edit.
  content: string | ((existing: string | null) => string),
  commitMessage: string,
  // `author` set = apply the frontmatter rules and report the new version (kb_write, kb_edit);
  // omitted = store verbatim (kb_init_project).
  // `baseVersion`: refuse if the note on disk differs. `guardShrink`: refuse a drastic body shrink.
  opts: { mustNotExist?: boolean; author?: string; baseVersion?: string; guardShrink?: boolean } = {},
): Promise<ToolRunResult> {
  try {
    const absolutePath = resolveNotePath(vaultRoot, target.space, target.project, target.section, target.note);
    const { author, baseVersion, guardShrink, ...writeOpts } = opts;
    let final = "";
    const { commitSha } = await syncWriteBuilt(
      vaultRoot,
      absolutePath,
      (prev) => {
        if (baseVersion !== undefined) assertBaseVersion(baseVersion, prev);
        const existing = prev ? prev.toString("utf8") : null;
        if (typeof content === "function" && prev && !Buffer.from(existing as string, "utf8").equals(prev)) {
          throw new NoteRuleError(NOTE_NOT_UTF8_MESSAGE, "note not utf-8");
        }
        const raw = typeof content === "function" ? content(existing) : content;
        // Before frontmatter is added, so the reported line matches what the client sent or read.
        assertNoSecret(raw);
        final =
          author === undefined ? raw : normalizeNote(raw, { section: target.section, author, today: utcToday(), existing });
        if (guardShrink && existing !== null) assertNoShrink(target.section, existing, final);
        return final;
      },
      commitMessage,
      // Rules and limits see the final bytes, frontmatter included.
      {
        ...writeOpts,
        check: (next) => {
          if (next.length > MAX_CONTENT_CHARS) {
            throw new NoteRuleError("The note would exceed the size limit (max 512 KB). Split it into several notes.", "note too large");
          }
          validateNoteContent(target, next);
          assertSpaceLimits(vaultRoot, target, Buffer.byteLength(next, "utf8"));
        },
      },
    );
    const version = author === undefined ? [] : [{ type: "text" as const, text: `version: ${noteVersion(Buffer.from(final, "utf8"))}` }];
    // Identical content: nothing was committed; never report HEAD (someone else's commit) as ours.
    if (commitSha === null) {
      return { toolResult: { content: [toolText(NO_CHANGES_MESSAGE).content[0], ...version] }, audit: { detail: "no changes (content identical)" } };
    }
    return { toolResult: { content: [toolText(commitSha).content[0], ...version] }, audit: { gitCommit: commitSha || undefined } };
  } catch (err) {
    if (err instanceof SpaceLimitError && err.noteBytes && opts.mustNotExist) {
      // Creating from the template: the user cannot shorten it, the admin config is at fault.
      const n = err.noteBytes;
      return {
        toolResult: toolError(
          `The ${n.space} space limit maxNoteBytes (${n.limit}) is too small for the project template (${n.bytes} bytes); ask the admin to raise it.`,
        ),
        audit: { detail: err.detail },
      };
    }
    if (err instanceof NoteRuleError) {
      return { toolResult: toolError(err.message), audit: { detail: err.detail } };
    }
    if (err instanceof NoteExistsError) {
      return {
        toolResult: toolError("Entry note already exists — edit it with kb_write."),
        audit: { detail: "entry note already exists" },
      };
    }
    throw err;
  }
}
