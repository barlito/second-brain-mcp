// "User context" appended to the server instructions on initialize: the entry notes of the `meta`
// space (overview/index of each project, the user's short notes on how they work) that the caller
// may read. Clients that pass instructions to the model at startup (Claude Code) then know the
// user's preferences without any tool call. Never breaks initialize: any failure = no context.
import { checkScope } from "./acl/check";
import { canReadUnderSpace } from "./acl/readable";
import { Scope } from "./auth/types";
import { ENTRY_NOTE_MAX_BYTES } from "./tools/conventions";
import { listSubdirs, readFileNoFollow } from "./vault/enumerate";
import { resolveNotePath } from "./vault/paths";
import { redact } from "./vault/git";

// Same value as SHARED_SPACE in cli/token.ts (not imported: that module is a CLI entry point).
const SHARED_SPACE = "meta";

// Total budget for the notes themselves; instructions are sent on every initialize.
export const USER_CONTEXT_MAX_BYTES = 8 * 1024;

export interface UserContext {
  text: string; // "" when there is nothing readable
  notes: string[]; // paths included, for the audit row
}

export async function buildUserContext(vaultRoot: string, scopes: Scope[]): Promise<UserContext> {
  const none = { text: "", notes: [] };
  if (!canReadUnderSpace(scopes, SHARED_SPACE)) return none;
  try {
    const parts: string[] = [];
    const notes: string[] = [];
    const skipped: string[] = [];
    let used = 0;
    for (const project of await listSubdirs(vaultRoot, [SHARED_SPACE])) {
      if (!checkScope(scopes, SHARED_SPACE, project, "overview", "read")) continue;
      let r: Awaited<ReturnType<typeof readFileNoFollow>>;
      try {
        r = await readFileNoFollow(resolveNotePath(vaultRoot, SHARED_SPACE, project, "overview", "index"), ENTRY_NOTE_MAX_BYTES);
      } catch {
        continue; // missing index, symlink, unreadable: skip that project
      }
      const body = r?.content.trim();
      if (!body) continue;
      const path = `${SHARED_SPACE}/${project}/overview/index`;
      if (used + r!.bytes > USER_CONTEXT_MAX_BYTES) {
        skipped.push(path);
        continue;
      }
      used += r!.bytes;
      notes.push(path);
      parts.push(`### ${path}\n\n${body}`);
    }
    if (parts.length === 0) return none;
    const more = skipped.length ? `\n\nNot included (size budget), read them with kb_read: ${skipped.join(", ")}.` : "";
    const text =
      `User context: the entry notes of the \`${SHARED_SPACE}\` space, the user's own short notes on how they work (preferences, general conventions). ` +
      `Follow them unless the user says otherwise in the conversation. Other ${SHARED_SPACE} notes are listed in each project's Docs map (kb_read if needed).\n\n` +
      parts.join("\n\n") +
      more;
    return { text, notes };
  } catch (err) {
    console.error(`user context build failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    return none;
  }
}
