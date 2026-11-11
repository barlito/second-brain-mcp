import { resolveNotePath } from "../vault/paths";
import { NoteExistsError, syncWrite } from "../vault/git";
import { toolError, toolText, ToolRunResult } from "./common";
import { NoteRuleError, validateNoteContent } from "./conventions";

// Shared write path (kb_write, kb_init_project): content rules, then path
// resolution, then the locked write. Call after the ACL check.
export async function writeNote(
  vaultRoot: string,
  target: { space: string; project: string; section: string; note: string },
  content: string,
  commitMessage: string,
  opts: { mustNotExist?: boolean } = {},
): Promise<ToolRunResult> {
  try {
    validateNoteContent(target, content);
    const absolutePath = resolveNotePath(vaultRoot, target.space, target.project, target.section, target.note);
    const { commitSha } = await syncWrite(vaultRoot, absolutePath, content, commitMessage, opts);
    return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
  } catch (err) {
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
