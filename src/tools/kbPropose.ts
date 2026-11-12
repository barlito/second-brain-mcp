import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  assertInboxQuota,
  InboxFullError,
  inboxPath,
  MAX_PROPOSAL_FILE_BYTES,
  MAX_REASON_CHARS,
  newInboxId,
  serializeProposal,
} from "../inbox";
import { syncWrite } from "../vault/git";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, toolError, toolText, withAclAndAudit } from "./common";
import { NoteRuleError, validateNoteContent } from "./conventions";
import { rejectReservedSection } from "./reserved";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
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
          .max(MAX_CONTENT_CHARS, "too large (max 512 KB)")
          .describe("Full proposed note content"),
        reason: z
          .string()
          .trim()
          .min(1, "must not be empty")
          .max(MAX_REASON_CHARS, `too long (max ${MAX_REASON_CHARS} characters)`)
          .describe("Why this note is worth adding"),
      },
    },
    async ({ space, project, section, note, content, reason }): Promise<CallToolResult> =>
      withAclAndAudit("kb_propose", { space, project, section, note }, ["propose", "write"], async (ctx) => {
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
        try {
          validateNoteContent({ section, note }, content);
        } catch (err) {
          if (err instanceof NoteRuleError) return { toolResult: toolError(err.message), audit: { detail: err.detail } };
          throw err;
        }
        const target = `${space}/${project}/${section}/${note}`;
        const now = new Date();
        const id = newInboxId(now);
        const file = serializeProposal({ target, proposedBy: ctx.name, reason, created: now.toISOString(), content });
        // The admin reader caps what it can show/accept: refuse what it could not manage.
        if (Buffer.byteLength(file, "utf8") > MAX_PROPOSAL_FILE_BYTES) {
          return {
            toolResult: toolError(`Proposal too large (max ${MAX_PROPOSAL_FILE_BYTES / 1024} KiB as UTF-8 including metadata).`),
            audit: { detail: "proposal too large (bytes)" },
          };
        }
        try {
          const { commitSha } = await syncWrite(vaultRoot, inboxPath(vaultRoot, id), file, `kb_propose: ${target} via ${ctx.name}`, {
            mustNotExist: true,
            precheck: () => assertInboxQuota(vaultRoot, ctx.name),
          });
          // A fresh proposal file always commits; null (nothing committed) must not borrow HEAD's sha.
          return { toolResult: toolText(id), audit: { gitCommit: commitSha || undefined, detail: `proposal ${id}` } };
        } catch (err) {
          if (err instanceof InboxFullError) return { toolResult: toolError(err.message), audit: { detail: "inbox full" } };
          throw err;
        }
      }),
  );
};
