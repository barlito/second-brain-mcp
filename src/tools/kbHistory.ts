import { existsSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { noteHistory } from "../vault/git";
import { checkScope } from "../acl/check";
import { isValidSlug, resolveNotePath } from "../vault/paths";
import { kbArgsShape, RegisterTool, registerKbTool, toolError, toolText, withAclAndAudit } from "./common";

const DEFAULT_LIMIT = 20;

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
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
      withAclAndAudit("kb_history", { space, project, section, note }, "read", async (ctx) => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        // Only paths that are valid <space>/<project>/<section>/<note>.md and readable by this
        // token count; anything else (e.g. _inbox/<id>.md) is unreadable.
        const canRead = (p: string): boolean => {
          const parts = p.split("/");
          if (parts.length !== 4 || !parts[3].endsWith(".md")) return false;
          const [sp, pj, sec] = parts;
          return [sp, pj, sec, parts[3].slice(0, -3)].every(isValidSlug) && checkScope(ctx.scopes, sp, pj, sec, "read");
        };
        const { path, entries, restricted } = await noteHistory(vaultRoot, absolutePath, limit ?? DEFAULT_LIMIT, canRead);
        const exists = existsSync(absolutePath);

        if (entries.length === 0 && !exists) {
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }
        const lines = entries.map((e) => `${e.sha} ${e.date} ${e.subject}`);
        if (restricted) lines.push("(earlier history not accessible with this token)");
        const gone = exists ? "" : " (no longer at this path)";
        return { toolResult: toolText(`path: ${path}${gone}\n${lines.length ? lines.join("\n") : "(no commits yet)"}`) };
      }),
  );
};
