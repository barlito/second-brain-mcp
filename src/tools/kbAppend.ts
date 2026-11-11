import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { NoteTooLargeError, syncAppend } from "../vault/git";
import { NoteRuleError, validateNoteContent } from "./conventions";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, toolError, toolText, withAclAndAudit } from "./common";
import { rejectReservedSection } from "./reserved";

export const MAX_ENTRY_CHARS = 1000;

// "2026-11-11 09:05 UTC"
function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Every line terminator / control char (\r \n \v \f NEL, U+2028/2029, other Cc) -> one space.
export function oneLineEntry(entry: string): string {
  return entry.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_append",
    {
      description:
        "Append one timestamped log line to a note (created if missing). The server writes " +
        "`- <YYYY-MM-DD HH:MM UTC> [<token name>] <entry>`. Entries are short: 1-3 sentences " +
        "(what was done and why); details go to `notes`/`decisions`. Line breaks and control characters are collapsed to spaces. " +
        "Convention: section `journal`, note = current month `YYYY-MM` (e.g. 2026-11). " +
        "The note size limit is the same as kb_write; use one journal note per month. " +
        "Section `archive` cannot be appended to. Read recent history with kb_read `tail`.",
      inputSchema: {
        ...kbArgsShape,
        entry: z.string().min(1).max(MAX_ENTRY_CHARS, "entry too long (max 1000 chars)").describe("Log entry, 1-3 sentences"),
      },
    },
    async ({ space, project, section, note, entry }): Promise<CallToolResult> =>
      withAclAndAudit("kb_append", { space, project, section, note }, "write", async (ctx) => {
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
        const oneLine = oneLineEntry(entry);
        if (!oneLine) return { toolResult: toolError("Entry is empty."), audit: { detail: "empty entry" } };

        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        try {
          // The line is built inside the vault lock so file order == timestamp order.
          const { commitSha } = await syncAppend(
            vaultRoot,
            absolutePath,
            () => `- ${utcStamp(new Date())} [${ctx.name}] ${oneLine}`,
            `kb_append: ${space}/${project}/${section}/${note} via ${ctx.name}`,
            MAX_CONTENT_CHARS,
            (next) => validateNoteContent({ section, note }, next),
          );
          return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
        } catch (err) {
          if (err instanceof NoteRuleError) {
            return { toolResult: toolError(err.message), audit: { detail: err.detail } };
          }
          if (err instanceof NoteTooLargeError) {
            return {
              toolResult: toolError(
                "Note is too large to append to (max 512 KB). Start a new note; for journals use one note per month (journal/YYYY-MM).",
              ),
              audit: { detail: "note too large" },
            };
          }
          throw err;
        }
      }),
  );
};
