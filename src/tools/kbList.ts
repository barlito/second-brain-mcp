import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canReadUnderProject, canReadUnderSpace } from "../acl/readable";
import { checkScope } from "../acl/check";
import { listNotes, listSubdirs } from "../vault/enumerate";
import { RegisterTool, toolText } from "./common";
import { ARCHIVE_SECTION, discoveryCall, optSlug } from "./discovery";

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
      discoveryCall("kb_list", { space, project, section }, (ctx) => {
        const scopes = ctx.scopes;
        const archived = include_archived === true;
        let lines: string[];

        if (space === undefined) {
          lines = listSubdirs(vaultRoot, []).filter((s) => canReadUnderSpace(scopes, s));
        } else if (project === undefined) {
          lines = listSubdirs(vaultRoot, [space]).filter((p) => canReadUnderProject(scopes, space, p));
        } else if (section === undefined) {
          lines = listSubdirs(vaultRoot, [space, project]).filter(
            (s) => (archived || s !== ARCHIVE_SECTION) && checkScope(scopes, space, project, s, "read"),
          );
        } else if (section === ARCHIVE_SECTION && !archived) {
          lines = [];
        } else {
          lines = listNotes(vaultRoot, [space, project, section]).map(
            (n) => `${n.name}\t${n.size} bytes\t${n.mtime.toISOString()}`,
          );
        }

        const truncated = lines.length > MAX_LIST_ENTRIES;
        if (truncated) lines = lines.slice(0, MAX_LIST_ENTRIES);
        let text = lines.length ? lines.join("\n") : "(empty)";
        if (truncated) text += `\n(truncated: showing the first ${MAX_LIST_ENTRIES} entries)`;
        return { result: toolText(text), detail: `entries=${lines.length}${truncated ? " truncated" : ""}` };
      }),
  );
};
