import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { syncAppend } from "../vault/git";
import { kbArgsShape, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";

export const MAX_ENTRY_CHARS = 1000;

// "2026-11-11 09:05 UTC"
function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_append",
    {
      description:
        "Append one timestamped log line to a note (created if missing). The server writes " +
        "`- <YYYY-MM-DD HH:MM UTC> [<token name>] <entry>`. Entries are short: 1-3 sentences " +
        "(what was done and why); details go to `notes`/`decisions`. Newlines are collapsed to spaces. " +
        "Convention: section `journal`, note = current month `YYYY-MM` (e.g. 2026-11). " +
        "Read recent history with kb_read `tail`.",
      inputSchema: {
        ...kbArgsShape,
        entry: z.string().min(1).max(MAX_ENTRY_CHARS, "entry too long (max 1000 chars)").describe("Log entry, 1-3 sentences"),
      },
    },
    async ({ space, project, section, note, entry }): Promise<CallToolResult> =>
      withAclAndAudit("kb_append", { space, project, section, note }, "write", async (ctx) => {
        const oneLine = entry.replace(/\s*[\r\n]+\s*/g, " ").trim();
        if (!oneLine) return { toolResult: toolError("Entry is empty."), audit: { detail: "empty entry" } };

        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        const line = `- ${utcStamp(new Date())} [${ctx.name}] ${oneLine}`;
        const { commitSha } = await syncAppend(
          vaultRoot,
          absolutePath,
          line,
          `kb_append: ${space}/${project}/${section}/${note} via ${ctx.name}`,
        );
        return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
      }),
  );
};
