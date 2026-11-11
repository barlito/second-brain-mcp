import { existsSync, readFileSync } from "node:fs";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_read",
    {
      description: "Read a note from the shared knowledge base vault.",
      inputSchema: kbArgsShape,
    },
    async ({ space, project, section, note }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", { space, project, section, note }, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);

        if (!existsSync(absolutePath)) {
          // Distinct from a permission error — the note simply doesn't exist.
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }

        return { toolResult: toolText(readFileSync(absolutePath, "utf8")) };
      }),
  );
};
