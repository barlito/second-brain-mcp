import { resolveNotePath } from "../vault/paths";
import { NoteExistsError, syncWriteBuilt } from "../vault/git";
import { NO_CHANGES_MESSAGE, toolError, toolText, ToolRunResult } from "./common";
import { NoteRuleError, validateNoteContent } from "./conventions";
import { assertSpaceLimits, SpaceLimitError } from "../limits";
import { normalizeNote, utcToday } from "./frontmatter";

// Shared write path (kb_write, kb_init_project): content rules, then path
// resolution, then the locked write. Call after the ACL check.
export async function writeNote(
  vaultRoot: string,
  target: { space: string; project: string; section: string; note: string },
  content: string,
  commitMessage: string,
  // `author` set = apply the frontmatter rules (kb_write); omitted = store verbatim (kb_init_project).
  opts: { mustNotExist?: boolean; author?: string } = {},
): Promise<ToolRunResult> {
  try {
    validateNoteContent(target, content);
    const absolutePath = resolveNotePath(vaultRoot, target.space, target.project, target.section, target.note);
    const { author, ...writeOpts } = opts;
    const { commitSha } = await syncWriteBuilt(
      vaultRoot,
      absolutePath,
      (prev) =>
        author === undefined
          ? content
          : normalizeNote(content, { section: target.section, author, today: utcToday(), existing: prev ? prev.toString("utf8") : null }),
      commitMessage,
      // Limits see the final bytes, frontmatter included.
      { ...writeOpts, check: (next) => assertSpaceLimits(vaultRoot, target, Buffer.byteLength(next, "utf8")) },
    );
    // Identical content: nothing was committed; never report HEAD (someone else's commit) as ours.
    if (commitSha === null) return { toolResult: toolText(NO_CHANGES_MESSAGE), audit: { detail: "no changes (content identical)" } };
    return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha || undefined } };
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
