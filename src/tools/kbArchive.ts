import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { kbArgsShape, RegisterTool, registerKbTool, toolError, toolText, withAclAndAudit } from "./common";
import { archiveNote } from "./archiveNote";
import { ARCHIVE_SECTION } from "./reserved";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
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
    async ({ space, project, section, note }): Promise<CallToolResult> =>
      withAclAndAudit(
        "kb_archive",
        { space, project, section, note },
        "write",
        async (ctx) => {
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
        },
        // Archiving also writes into <space>:<project>:archive, so it needs write there too.
        [{ permission: "write", section: ARCHIVE_SECTION, detail: "no write on archive section" }],
      ),
  );
};
