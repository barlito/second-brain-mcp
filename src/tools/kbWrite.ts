import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { syncWrite } from "../vault/git";
import { rejectReservedSection } from "./reserved";
import { kbArgsShape,MAX_CONTENT_CHARS, RegisterTool, toolText, withAclAndAudit } from "./common";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_write",
    {
      description: "Write (create or overwrite) a note in the shared knowledge base vault.",
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
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
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
