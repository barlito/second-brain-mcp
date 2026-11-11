import { existsSync } from "node:fs";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { MoveSourceMissingError, MoveTargetExistsError, syncMove } from "../vault/git";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";

const MAX_SLUG = 64;
const MAX_ATTEMPTS = 50;

// n=1 -> "<stem>", n>=2 -> "<stem>-<n>"; the stem is truncated to stay a valid slug.
export function archiveName(section: string, note: string, n: number): string {
  const suffix = n === 1 ? "" : `-${n}`;
  const stem = `${section}-${note}`.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "");
  return stem + suffix;
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_archive",
    {
      description:
        "Archive a note instead of deleting it (there is no delete tool; history is kept in git). " +
        "Moves <space>/<project>/<section>/<note> to <space>/<project>/archive/<section>-<note> " +
        "(suffix -2, -3... if that name is taken). Notes already in `archive` and the project " +
        "entry note overview/index cannot be archived. Returns the new location.",
      inputSchema: kbArgsShape,
    },
    async ({ space, project, section, note }): Promise<CallToolResult> =>
      withAclAndAudit("kb_archive", { space, project, section, note }, "write", async (ctx) => {
        if (section === "archive") {
          return { toolResult: toolError("Note is already archived."), audit: { detail: "already in archive" } };
        }
        if (section === "overview" && note === "index") {
          return { toolResult: toolError("The project entry note (overview/index) cannot be archived."), audit: { detail: "entry note" } };
        }
        const from = resolveNotePath(vaultRoot, space, project, section, note);
        if (!existsSync(from)) {
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }

        const msg = `kb_archive: ${space}/${project}/${section}/${note} via ${ctx.name}`;
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          const name = archiveName(section, note, n);
          const to = resolveNotePath(vaultRoot, space, project, "archive", name);
          if (existsSync(to)) continue;
          try {
            const { commitSha } = await syncMove(vaultRoot, from, to, msg);
            return {
              toolResult: toolText(`${space}/${project}/archive/${name}`),
              audit: { gitCommit: commitSha },
            };
          } catch (err) {
            if (err instanceof MoveTargetExistsError) continue; // lost a race: next name
            if (err instanceof MoveSourceMissingError) {
              return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
            }
            throw err;
          }
        }
        return { toolResult: toolError("Too many archived notes with this name."), audit: { detail: "no free archive name" } };
      }),
  );
};
