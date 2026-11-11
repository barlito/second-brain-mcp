import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_REASON_CHARS, inboxPath, newInboxId, serializeProposal } from "../inbox";
import { syncWrite } from "../vault/git";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";
import { NoteRuleError, validateNoteContent } from "./conventions";
import { ARCHIVE_SECTION } from "./reserved";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_propose",
    {
      description:
        "Propose a note for the user to review instead of writing it, when you are not sure it deserves to be in the " +
        "knowledge base. Nothing is written to the target; the proposal waits in a private inbox the user reviews " +
        "(accept or reject). Needs propose or write on the target section. Same content rules as kb_write. " +
        "Returns the proposal id.",
      inputSchema: {
        ...kbArgsShape,
        content: z
          .string()
          .max(MAX_CONTENT_CHARS, "content too large (max 512 KB)")
          .describe("Full proposed note content"),
        reason: z
          .string()
          .trim()
          .min(1, "reason must not be empty")
          .max(MAX_REASON_CHARS, `reason too long (max ${MAX_REASON_CHARS} characters)`)
          .describe("Why this note is worth adding"),
      },
    },
    async ({ space, project, section, note, content, reason }): Promise<CallToolResult> =>
      withAclAndAudit("kb_propose", { space, project, section, note }, ["propose", "write"], async (ctx) => {
        if (section === ARCHIVE_SECTION) {
          return {
            toolResult: toolError("Section `archive` is managed by kb_archive; it cannot be a proposal target."),
            audit: { detail: "reserved section" },
          };
        }
        try {
          validateNoteContent({ section, note }, content);
        } catch (err) {
          if (err instanceof NoteRuleError) return { toolResult: toolError(err.message), audit: { detail: err.detail } };
          throw err;
        }
        const target = `${space}/${project}/${section}/${note}`;
        const now = new Date();
        const id = newInboxId(now);
        const { commitSha } = await syncWrite(
          vaultRoot,
          inboxPath(vaultRoot, id),
          serializeProposal({ target, proposedBy: ctx.name, reason, created: now.toISOString(), content }),
          `kb_propose: ${target} via ${ctx.name}`,
          { mustNotExist: true },
        );
        return { toolResult: toolText(id), audit: { gitCommit: commitSha, detail: `proposal ${id}` } };
      }),
  );
};
