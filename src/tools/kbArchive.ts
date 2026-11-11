import { existsSync } from "node:fs";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext } from "../auth/context";
import { checkScope } from "../acl/check";
import { logAudit } from "../audit";
import { isValidSlug, resolveNotePath } from "../vault/paths";
import { MoveSourceDirtyError, MoveSourceMissingError, MoveTargetExistsError, redact, syncMove } from "../vault/git";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";
import { ARCHIVE_SECTION } from "./reserved";

const MAX_SLUG = 64;
const MAX_ATTEMPTS = 50;

// n=1 -> "<stem>", n>=2 -> "<stem>-<n>"; the stem is truncated to stay a valid slug.
export function archiveName(section: string, note: string, n: number): string {
  const suffix = n === 1 ? "" : `-${n}`;
  const stem = `${section}-${note}`.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "");
  return stem + suffix;
}

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
        if (section === ARCHIVE_SECTION) {
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
          const to = resolveNotePath(vaultRoot, space, project, ARCHIVE_SECTION, name);
          if (existsSync(to)) continue;
          try {
            const { commitSha } = await syncMove(vaultRoot, from, to, msg);
            return {
              toolResult: toolText(`${space}/${project}/archive/${name}`),
              audit: { gitCommit: commitSha || undefined, detail: `-> archive/${name}` },
            };
          } catch (err) {
            if (err instanceof MoveTargetExistsError) continue; // lost a race: next name
            if (err instanceof MoveSourceMissingError) {
              return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
            }
            if (err instanceof MoveSourceDirtyError) {
              return {
                toolResult: toolError("Note has uncommitted changes in the vault; commit or discard them first."),
                audit: { detail: "uncommitted changes" },
              };
            }
            throw err;
          }
        }
        return { toolResult: toolError("Too many archived notes with this name."), audit: { detail: "no free archive name" } };
      });
    },
  );
};
