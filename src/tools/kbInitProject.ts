import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { projectArg, RegisterTool, registerKbTool, spaceArg, toolText, withAclAndAudit } from "./common";
import {
  AGENTS_SPACE_RULE,
  DOCS_MAP_RULE,
  ENTRY_NOTE,
  ENTRY_NOTE_MAX_BYTES,
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
        `Fails if it already exists (edit it with kb_write). Requires write access on the overview section. ${DOCS_MAP_RULE} ${RESERVED_SECTIONS_SUMMARY} overview/index is capped at ${ENTRY_NOTE_MAX_BYTES / 1024} KB. ${AGENTS_SPACE_RULE}`,
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
          const r = await writeNote(
            vaultRoot,
            { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE },
            entryNoteTemplate(project, summary, space),
            `kb_init_project: ${space}/${project} via ${ctx.name}`,
            { mustNotExist: true },
          );
          const sha = r.toolResult.content[0];
          if (r.toolResult.isError || sha.type !== "text") return r;
          return { ...r, toolResult: toolText(`Created ${space}/${project}/${OVERVIEW_SECTION}/${ENTRY_NOTE} (commit ${sha.text}).`) };
        },
      ),
  );
};
