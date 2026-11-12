import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { projectArg, RegisterTool, registerKbTool, spaceArg, withAclAndAudit } from "./common";
import {
  ENTRY_NOTE,
  entryNoteTemplate,
  OVERVIEW_SECTION,
  RESERVED_SECTIONS_SUMMARY,
  SUMMARY_MAX_CHARS,
} from "./conventions";
import { writeNote } from "./writeNote";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_init_project",
    {
      description:
        "Create a project's entry note (<space>/<project>/overview/index) from a template: title, summary and a docs map. " +
        `Fails if it already exists (edit it with kb_write). Requires write access on the overview section. ${RESERVED_SECTIONS_SUMMARY}`,
      inputSchema: {
        space: spaceArg,
        project: projectArg,
        summary: z
          .string()
          .trim()
          .min(1, "must not be empty")
          .max(SUMMARY_MAX_CHARS, `too long (max ${SUMMARY_MAX_CHARS} characters)`)
          .describe("What the project is, in a few sentences"),
      },
    },
    async ({ space, project, summary }): Promise<CallToolResult> =>
      withAclAndAudit(
        "kb_init_project",
        { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE },
        "write",
        async (ctx) => {
          return writeNote(
            vaultRoot,
            { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE },
            entryNoteTemplate(project, summary),
            `kb_init_project: ${space}/${project} via ${ctx.name}`,
            { mustNotExist: true },
          );
        },
      ),
  );
};
