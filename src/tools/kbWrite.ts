import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, withAclAndAudit } from "./common";
import { ENTRY_NOTE_MAX_BYTES, RESERVED_SECTIONS_SUMMARY } from "./conventions";
import { rejectReservedSection } from "./reserved";
import { writeNote } from "./writeNote";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_write",
    {
      description:
        "Write (create or overwrite) a note in the shared knowledge base vault. " +
        `${RESERVED_SECTIONS_SUMMARY} overview/index is capped at ${ENTRY_NOTE_MAX_BYTES} bytes.`,
      inputSchema: {
        ...kbArgsShape,
        content: z
          .string()
          .max(MAX_CONTENT_CHARS, "too large (max 512 KB)")
          .describe("Full note content, written verbatim"),
      },
    },
    async ({ space, project, section, note, content }): Promise<CallToolResult> =>
      withAclAndAudit("kb_write", { space, project, section, note }, "write", async (ctx) => {
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
        return writeNote(
          vaultRoot,
          { space, project, section, note },
          content,
          `kb_write: ${space}/${project}/${section}/${note} via ${ctx.name}`,
        );
      }),
  );
};
