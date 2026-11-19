// KB organisation conventions: shared constants and the text shown to agents.
import { ARCHIVE_PURPOSE, ARCHIVE_SECTION } from "./reserved";

export const OVERVIEW_SECTION = "overview";
export const ENTRY_NOTE = "index";
// Max UTF-8 size of <space>/<project>/overview/index.md (the project entry note).
export const ENTRY_NOTE_MAX_BYTES = 3 * 1024;
export const SUMMARY_MAX_CHARS = 500;

export const RESERVED_SECTIONS: ReadonlyArray<{ section: string; purpose: string }> = [
  { section: "overview", purpose: "entry note `index`: what the project is + a map of its docs" },
  { section: "decisions", purpose: "why X was chosen: short ADR-style notes" },
  { section: "conventions", purpose: "how things are done in this project" },
  { section: "notes", purpose: "everything else" },
  { section: "journal", purpose: "monthly notes `YYYY-MM`, short entries, written with `kb_append`" },
  { section: ARCHIVE_SECTION, purpose: ARCHIVE_PURPOSE },
];

export const RESERVED_SECTIONS_SUMMARY = `Reserved sections: ${RESERVED_SECTIONS.map((s) => `${s.section} (${s.purpose})`).join("; ")}.`;

// Thrown when content breaks a note rule (e.g. the entry-note size cap).
export class NoteRuleError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "NoteRuleError";
  }
}

// One rule set for every writer (kb_write, kb_init_project, kb_append); throws NoteRuleError.
export function validateNoteContent(target: { section: string; note: string }, content: string): void {
  if (target.section !== OVERVIEW_SECTION || target.note !== ENTRY_NOTE) return;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ENTRY_NOTE_MAX_BYTES) {
    throw new NoteRuleError(entryNoteTooLargeMessage(bytes), `entry note too large (${bytes} bytes)`);
  }
}

export function entryNoteTooLargeMessage(bytes: number): string {
  return (
    `overview/index is too large (${bytes} bytes, max ${ENTRY_NOTE_MAX_BYTES}). ` +
    "The entry note must stay small: move detail into other sections (decisions, conventions, notes) " +
    "and link to those notes from the Docs map."
  );
}

// Per-agent working memory space: overview/index doubles as the handover note.
export const AGENTS_SPACE = "agents";

export function entryNoteTemplate(project: string, summary: string, space?: string): string {
  const map = RESERVED_SECTIONS.filter((s) => s.section !== "overview")
    .map((s) => `- \`${s.section}\`: ${s.purpose}`)
    .join("\n");
  if (space === AGENTS_SPACE) {
    return (
      `# ${project}\n\n${summary}\n\n## Role\n\n(what this agent is for)\n\n## Current state\n\n(where things stand)\n\n` +
      `## Current task\n\n(what is being done now)\n\n## Next step\n\n(the very next action, so another agent can resume)\n\n` +
      `## Key notes\n\n(links to the notes that matter; keep this index up to date)\n\n## Docs map\n\n${map}\n`
    );
  }
  return `# ${project}\n\n${summary}\n\n## Docs map\n\n${map}\n\nAdd key notes here as they are created (link them under the right section).\n`;
}

// Compact on purpose: clients cut instructions at a size cap (see src/instructions.ts). The per-tool
// rules (frontmatter, Docs map, access flow, ...) live in the descriptions of the tools they concern.
export const SERVER_INSTRUCTIONS = `Knowledge base (git vault): <space>/<project>/<section>/<note>, lowercase slugs; you only see what your token allows. Rules for each action are in that tool's description.
Starting on a project: kb_context <space>/<project> (overview/index, journal tail, sections); kb_read_many to read several notes.
Meta (how the user works): the "User context" below, if any, holds meta's index notes, only a map: kb_read_many the notes they reference before your first answer, at least those on profile and workflow. Else kb_list/kb_read meta.
No token: kb_* answer "No access for this session"; call kb_request_access only when you need it (see its description).`;

// Shared tool-description fragments (kept here so the text exists once).
export const DOCS_MAP_RULE =
  "When you add an important note, update the Docs map in overview/index (keep that note small, move detail elsewhere).";
export const AGENTS_SPACE_RULE =
  "Space `agents` is per-agent scratch working memory (agents/<agent-name>): its overview/index is the handover note another agent resumes from, keep it up to date. " +
  "The server may cap notes and sizes there and auto-archive stale notes (a refused write says what to condense or kb_archive); durable knowledge belongs in the real project (kb_propose or kb_write), not in agents.";
