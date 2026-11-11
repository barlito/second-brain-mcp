import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_read",
    {
      description:
        "Read a note from the shared knowledge base vault. Pass `tail` (1-500) to get only the last N lines, e.g. recent journal history.",
      inputSchema: {
        ...kbArgsShape,
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of the note"),
      },
    },
    async ({ space, project, section, note, tail }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", { space, project, section, note }, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);

        if (!existsSync(absolutePath)) {
          // Distinct from a permission error — the note simply doesn't exist.
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }

        const text = readFileSync(absolutePath, "utf8");
        if (tail === undefined) return { toolResult: toolText(text) };
        const lines = text.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        return { toolResult: toolText(lines.slice(-tail).join("\n") + (lines.length ? "\n" : "")) };
      }),
  );
};
