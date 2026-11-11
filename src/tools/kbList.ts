import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listNoteNames, statNote } from "../vault/enumerate";
import { RegisterTool, toolText } from "./common";
import { discoveryCall, optSlug, readableChildren } from "./discovery";

export const MAX_LIST_ENTRIES = 500;

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_list",
    {
      description:
        "List the knowledge base one level at a time, only what this token can read. " +
        "No args: spaces. space: projects. space+project: sections. space+project+section: notes " +
        "(name, bytes, last modified). Archived notes (section 'archive') are hidden unless include_archived is true.",
      inputSchema: {
        space: optSlug("space"),
        project: optSlug("project"),
        section: optSlug("section"),
        include_archived: z.boolean().optional().describe("Also show the 'archive' section (default false)"),
      },
    },
    async ({ space, project, section, include_archived }): Promise<CallToolResult> =>
      discoveryCall("kb_list", { space, project, section }, async (ctx) => {
        const archived = include_archived === true;
        let lines: string[];
        let truncated: boolean;

        if (section === undefined) {
          const parts = [space, project].filter((p): p is string => p !== undefined);
          const names = await readableChildren(vaultRoot, ctx.scopes, parts, archived);
          truncated = names.length > MAX_LIST_ENTRIES;
          lines = names.slice(0, MAX_LIST_ENTRIES);
        } else {
          // space and project are set here (hierarchy checked by discoveryCall).
          const parts = [space as string, project as string, section];
          const visible = await readableChildren(vaultRoot, ctx.scopes, parts.slice(0, 2), archived, section);
          const names = visible.length ? await listNoteNames(vaultRoot, parts) : [];
          truncated = names.length > MAX_LIST_ENTRIES;
          // Cap BEFORE stat'ing.
          lines = [];
          for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
            const n = await statNote(vaultRoot, parts, name);
            if (n) lines.push(`${n.name}\t${n.size} bytes\t${n.mtime.toISOString()}`);
          }
        }

        let text = lines.length ? lines.join("\n") : "(empty)";
        if (truncated) text += `\n(truncated: showing the first ${MAX_LIST_ENTRIES} entries)`;
        return { toolResult: toolText(text), audit: { detail: `entries=${lines.length}${truncated ? " truncated" : ""}` } };
      }),
  );
};
