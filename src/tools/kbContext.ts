import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TokenContext } from "../auth/context";
import { checkScope } from "../acl/check";
import { canReadUnderProject } from "../acl/readable";
import { isValidSlug } from "../vault/paths";
import { listNoteNames } from "../vault/enumerate";
import {
  auditedCall,
  Gate,
  INVALID_NAME,
  PERMISSION_DENIED,
  projectArg,
  RegisterTool,
  registerKbTool,
  spaceArg,
  Target,
  ToolRunResult,
  toolText,
  withAclAndAudit,
} from "./common";
import { readableChildren } from "./discovery";
import { ENTRY_NOTE, OVERVIEW_SECTION } from "./conventions";
import { NOT_FOUND_MESSAGE, readNote } from "./kbRead";

const JOURNAL = "journal";
const MONTH = /^\d{4}-\d{2}$/;
const DEFAULT_JOURNAL_LINES = 30;

type Run = (ctx: TokenContext) => Promise<ToolRunResult>;
// A part is its text, or the refusal to show if no part at all is readable.
type Part = { body: string } | { refusal: CallToolResult };
const isBody = (p: Part): p is { body: string } => "body" in p;

const textOf = (r: CallToolResult): string => (r.content[0]?.type === "text" ? r.content[0].text : "");
const quiet = (detail: string): ToolRunResult => ({ toolResult: toolText(""), audit: { detail } });

// Runs one audited step; `produce` returns the part's text. A gate refusal gives no text.
async function part(call: (run: Run) => Promise<CallToolResult>, produce: (ctx: TokenContext) => Promise<{ run: ToolRunResult; body: string }>): Promise<Part> {
  let body: string | undefined;
  const r = await call(async (ctx) => {
    const out = await produce(ctx);
    body = out.body;
    return out.run;
  });
  return body === undefined ? { refusal: r } : { body };
}

async function noteBody(vaultRoot: string, t: Target, tail?: number): Promise<{ run: ToolRunResult; body: string }> {
  const run = await readNote(vaultRoot, t, tail);
  return { run, body: textOf(run.toolResult) };
}

async function indexPart(vaultRoot: string, space: string, project: string): Promise<Part> {
  const t = { space, project, section: OVERVIEW_SECTION, note: ENTRY_NOTE };
  const p = await part(
    (run) => withAclAndAudit("kb_context", t, "read", run),
    async () => {
      const { run, body } = await noteBody(vaultRoot, t);
      return { run, body: body === NOT_FOUND_MESSAGE ? "(missing: create it with kb_init_project)" : body };
    },
  );
  return isBody(p) ? { body: `## ${space}/${project}/overview/index\n${p.body}` } : p;
}

// Listing the journal is its own audited step (ACL first); the latest month is then read as a normal note.
async function journalPart(vaultRoot: string, space: string, project: string, lines: number): Promise<Part> {
  const target = { space, project, section: JOURNAL };
  const gate: Gate = (c) => (checkScope(c.scopes, space, project, JOURNAL, "read") ? undefined : { result: "denied", message: PERMISSION_DENIED });
  const none = `## ${space}/${project}/journal\n(no journal yet)`;
  return part(
    (run) => auditedCall("kb_context", target, gate, run),
    async () => {
      const months = (await listNoteNames(vaultRoot, [space, project, JOURNAL])).filter((n) => MONTH.test(n));
      const latest = months[months.length - 1];
      if (!latest) return { run: quiet("no journal"), body: none };
      const t = { ...target, note: latest };
      const read = await part(
        (run) => withAclAndAudit("kb_context", t, "read", run),
        () => noteBody(vaultRoot, t, lines),
      );
      const body = isBody(read) ? `## ${space}/${project}/journal/${latest} (last ${lines} lines)\n${read.body}` : none;
      return { run: quiet(`latest=${latest}`), body };
    },
  );
}

// Readable sections with their note counts, archive excluded.
async function sectionsPart(vaultRoot: string, space: string, project: string): Promise<Part> {
  const gate: Gate = (c) => (canReadUnderProject(c.scopes, space, project) ? undefined : { result: "denied", message: PERMISSION_DENIED });
  return part(
    (run) => auditedCall("kb_context", { space, project }, gate, run),
    async (ctx) => {
      const names = await readableChildren(vaultRoot, ctx.scopes, [space, project], false);
      const counts = await Promise.all(names.map(async (s) => `${s} (${(await listNoteNames(vaultRoot, [space, project, s])).length})`));
      return { run: quiet(`sections=${counts.length}`), body: counts.length ? `Sections: ${counts.join(", ")}` : "" };
    },
  );
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
      if (!isValidSlug(space) || !isValidSlug(project)) {
        return auditedCall("kb_context", { space, project }, () => ({ result: "error", message: INVALID_NAME, detail: "invalid slug" }), async () => {
          throw new Error("unreachable");
        });
      }
      const parts = [
        await indexPart(vaultRoot, space, project),
        await journalPart(vaultRoot, space, project, journal_lines ?? DEFAULT_JOURNAL_LINES),
        await sectionsPart(vaultRoot, space, project),
      ];
      const bodies = parts.filter(isBody).map((p) => p.body).filter(Boolean);
      if (bodies.length > 0) return toolText(bodies.join("\n\n"));
      return (parts.find((p) => !isBody(p)) as { refusal: CallToolResult }).refusal;
    },
  );
};
