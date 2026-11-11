import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext } from "../auth/context";
import { checkScope } from "../acl/check";
import { logAudit } from "../audit";
import { isValidSlug } from "../vault/paths";
import { redact } from "../vault/git";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";
import { archiveNote } from "./archiveNote";
import { ARCHIVE_SECTION } from "./reserved";

// Archiving also writes into <space>:<project>:archive, so it needs write there too.
// Checked (and a denial audited) before any filesystem access. The source-section
// check is done by withAclAndAudit.
function archiveWriteDenied(space: string, project: string, section: string, note: string): boolean {
  if (![space, project, section, note].every(isValidSlug)) return false; // wrapper reports it
  let ctx;
  try {
    ctx = getTokenContext();
  } catch {
    return false; // wrapper reports it
  }
  if (checkScope(ctx.scopes, space, project, ARCHIVE_SECTION, "write")) return false;
  try {
    logAudit({
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action: "kb_archive",
      space,
      project,
      section,
      note,
      result: "denied",
      detail: "no write on archive section",
      clientIp: ctx.clientIp,
    });
  } catch (err) {
    console.error(`audit write failed (action=kb_archive token=${ctx.name} result=denied): ${redact(String(err))}`);
  }
  return true;
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_archive",
    {
      description:
        "Archive a note instead of deleting it (there is no delete tool; history is kept in git). " +
        "Moves <space>/<project>/<section>/<note> to <space>/<project>/archive/<section>-<note> " +
        "(suffix -2, -3... if that name is taken). Requires write on the source section AND write on " +
        "<space>:<project>:archive, so section-scoped tokens cannot archive (project-wide `space:project:*` can). " +
        "Reading an archived note needs read on `archive`. Notes already in `archive`, the project " +
        "entry note overview/index, and notes with uncommitted changes in the vault cannot be archived. " +
        "Returns the new location.",
      inputSchema: kbArgsShape,
    },
    async ({ space, project, section, note }): Promise<CallToolResult> => {
      if (archiveWriteDenied(space, project, section, note)) return toolError("Permission denied.");
      return withAclAndAudit("kb_archive", { space, project, section, note }, "write", async (ctx) => {
        const r = await archiveNote(
          vaultRoot,
          { space, project, section, note },
          `kb_archive: ${space}/${project}/${section}/${note} via ${ctx.name}`,
        );
        if (!r.ok) return { toolResult: toolError(r.message), audit: { detail: r.detail } };
        return {
          toolResult: toolText(`${space}/${project}/archive/${r.name}`),
          audit: { gitCommit: r.commitSha || undefined, detail: `-> archive/${r.name}` },
        };
      });
    },
  );
};
