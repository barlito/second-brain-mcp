import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkScope } from "../acl/check";
import { canReadUnderProject } from "../acl/readable";
import { isValidSlug } from "../vault/paths";
import { listNoteNames } from "../vault/enumerate";
import {
  auditedCall,
  INVALID_NAME,
  PERMISSION_DENIED,
  projectArg,
  RegisterTool,
  registerKbTool,
  spaceArg,
  Target,
  toolError,
  toolText,
  withAclAndAudit,
} from "./common";
import { readableChildren } from "./discovery";
import { ENTRY_NOTE, OVERVIEW_SECTION } from "./conventions";
import { NOT_FOUND_MESSAGE, readNote } from "./kbRead";
import { ARCHIVE_SECTION } from "./reserved";

const JOURNAL = "journal";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_JOURNAL_LINES = 30;

const textOf = (r: CallToolResult): string => (r.content[0]?.type === "text" ? r.content[0].text : "");

async function indexBody(vaultRoot: string, space: string, project: string): Promise<string> {
  const t = { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE };
  const r = await withAclAndAudit("kb_context", t, "read", () => readNote(vaultRoot, t));
  const text = textOf(r);
  return `## ${space}/${project}/overview/index\n${text === NOT_FOUND_MESSAGE ? "(missing: create it with kb_init_project)" : text}`;
}

// The journal is listed inside the audited read of its latest note (one row, `latest=` in its detail).
async function journalBody(vaultRoot: string, space: string, project: string, lines: number): Promise<string> {
  const months = (await listNoteNames(vaultRoot, [space, project, JOURNAL])).filter((n) => MONTH.test(n));
  const latest = months[months.length - 1];
  if (!latest) return `## ${space}/${project}/journal\n(no journal yet)`;
  const t: Target = { space, project, section: JOURNAL, note: latest };
  const r = await withAclAndAudit("kb_context", t, "read", async () => {
    const read = await readNote(vaultRoot, t, lines);
    const detail = [read.audit?.detail, `latest=${latest}`].filter(Boolean).join(" ");
    return { ...read, audit: { ...read.audit, detail } };
  });
  return `## ${space}/${project}/journal/${latest} (last ${lines} lines)\n${textOf(r)}`;
}

// Readable sections with their note counts, archive excluded; undefined when there are none.
async function sectionsLine(vaultRoot: string, scopes: Parameters<typeof checkScope>[0], space: string, project: string) {
  const names = await readableChildren(vaultRoot, scopes, [space, project], false);
  const counts = await Promise.all(names.map(async (s) => `${s} (${(await listNoteNames(vaultRoot, [space, project, s])).length})`));
  return counts.length ? { line: `Sections: ${counts.join(", ")}`, n: counts.length } : undefined;
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_context",
    {
      description:
        "Start a session on a project in one call: overview/index, the tail of the latest journal month, and the section list with note counts (archive excluded). " +
        "Each part needs read on its section; unreadable parts are left out, and `Permission denied.` if none is readable.",
      inputSchema: {
        space: spaceArg,
        project: projectArg,
        journal_lines: z.number().int().min(1).max(200).optional().describe("Journal lines to return (default 30)"),
      },
    },
    async ({ space, project, journal_lines }): Promise<CallToolResult> => {
      const target = { space, project };
      const gate = (c: { scopes: Parameters<typeof checkScope>[0] }) => {
        if (!isValidSlug(space) || !isValidSlug(project)) return { result: "error" as const, message: INVALID_NAME, detail: "invalid slug" };
        // Archive is never part of the context: a token that only reads it has nothing to see.
        const visible = c.scopes.filter((s) => s.section !== ARCHIVE_SECTION);
        return canReadUnderProject(visible, space, project) ? undefined : { result: "denied" as const, message: PERMISSION_DENIED };
      };
      return auditedCall("kb_context", target, gate, async (ctx) => {
        const parts: string[] = [];
        if (checkScope(ctx.scopes, space, project, OVERVIEW_SECTION, "read")) parts.push(await indexBody(vaultRoot, space, project));
        if (checkScope(ctx.scopes, space, project, JOURNAL, "read")) {
          parts.push(await journalBody(vaultRoot, space, project, journal_lines ?? DEFAULT_JOURNAL_LINES));
        }
        const sections = await sectionsLine(vaultRoot, ctx.scopes, space, project);
        if (sections) parts.push(sections.line);
        if (parts.length === 0) return { toolResult: toolError(PERMISSION_DENIED), audit: { detail: "nothing to show" } };
        return { toolResult: toolText(parts.join("\n\n")), audit: { detail: `sections=${sections?.n ?? 0}` } };
      });
    },
  );
};
