import { existsSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { noteHistory } from "../vault/git";
import { resolveNotePath } from "../vault/paths";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";

const DEFAULT_LIMIT = 20;

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_history",
    {
      description:
        "Show the git history of a note (newest first, follows renames such as archiving): the current path, then `<short sha> <ISO date> <subject>` per line.",
      inputSchema: {
        ...kbArgsShape,
        limit: z.number().int().min(1).max(100).optional().describe(`Max entries (default ${DEFAULT_LIMIT}, max 100)`),
      },
    },
    async ({ space, project, section, note, limit }): Promise<CallToolResult> =>
      withAclAndAudit("kb_history", { space, project, section, note }, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        const { path, entries } = await noteHistory(vaultRoot, absolutePath, limit ?? DEFAULT_LIMIT);
        const exists = existsSync(absolutePath);

        if (entries.length === 0 && !exists) {
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }
        const lines = entries.map((e) => `${e.sha} ${e.date} ${e.subject}`);
        const gone = exists ? "" : " (no longer at this path)";
        return { toolResult: toolText(`path: ${path}${gone}\n${lines.length ? lines.join("\n") : "(no commits yet)"}`) };
      }),
  );
};
