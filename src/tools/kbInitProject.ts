import { existsSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { syncWrite } from "../vault/git";
import { projectArg, RegisterTool, spaceArg, toolError, toolText, withAclAndAudit } from "./common";
import {
  ENTRY_NOTE,
  entryNoteTemplate,
  OVERVIEW_SECTION,
  RESERVED_SECTIONS_SUMMARY,
  SUMMARY_MAX_CHARS,
} from "./conventions";

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
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
          .min(1, "summary must not be empty")
          .max(SUMMARY_MAX_CHARS, `summary too long (max ${SUMMARY_MAX_CHARS} characters)`)
          .describe("What the project is, in a few sentences"),
      },
    },
    async ({ space, project, summary }): Promise<CallToolResult> =>
      withAclAndAudit(
        "kb_init_project",
        { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE },
        "write",
        async (ctx) => {
          const absolutePath = resolveNotePath(vaultRoot, space, project, OVERVIEW_SECTION, ENTRY_NOTE);
          if (existsSync(absolutePath)) {
            return {
              toolResult: toolError(
                `${space}/${project}/overview/index already exists. Edit it with kb_write instead.`,
              ),
              audit: { detail: "entry note already exists" },
            };
          }
          const { commitSha } = await syncWrite(
            vaultRoot,
            absolutePath,
            entryNoteTemplate(project, summary),
            `kb_init_project: ${space}/${project} via ${ctx.name}`,
          );
          return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
        },
      ),
  );
};
