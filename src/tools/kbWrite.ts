import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { syncWrite } from "../vault/git";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";
import {
  ENTRY_NOTE,
  ENTRY_NOTE_MAX_BYTES,
  entryNoteTooLargeMessage,
  OVERVIEW_SECTION,
  RESERVED_SECTIONS_SUMMARY,
} from "./conventions";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_write",
    {
      description:
        "Write (create or overwrite) a note in the shared knowledge base vault. " +
        `${RESERVED_SECTIONS_SUMMARY} overview/index is capped at ${ENTRY_NOTE_MAX_BYTES} bytes.`,
      inputSchema: {
        ...kbArgsShape,
        content: z
          .string()
          .max(MAX_CONTENT_CHARS, "content too large (max 512 KB)")
          .describe("Full note content, written verbatim"),
      },
    },
    async ({ space, project, section, note, content }): Promise<CallToolResult> =>
      withAclAndAudit("kb_write", { space, project, section, note }, "write", async (ctx) => {
        if (section === OVERVIEW_SECTION && note === ENTRY_NOTE) {
          const bytes = Buffer.byteLength(content, "utf8");
          if (bytes > ENTRY_NOTE_MAX_BYTES) {
            return {
              toolResult: toolError(entryNoteTooLargeMessage(bytes)),
              audit: { detail: `entry note too large (${bytes} bytes)` },
            };
          }
        }
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        const { commitSha } = await syncWrite(
          vaultRoot,
          absolutePath,
          content,
          `kb_write: ${space}/${project}/${section}/${note} via ${ctx.name}`,
        );

        return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
      }),
  );
};
