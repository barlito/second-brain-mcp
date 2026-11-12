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

const SECTION_BULLETS = RESERVED_SECTIONS.map((r) => `- ${r.section}: ${r.purpose}`).join("\n");

export const SERVER_INSTRUCTIONS = `Shared knowledge base (git-backed vault). Layout: <space>/<project>/<section>/<note>.md. Spaces, projects, sections and notes are lowercase slugs (a-z, 0-9, hyphen). You only see what your token allows.

Reserved sections in every project (overview/index has a hard ${ENTRY_NOTE_MAX_BYTES / 1024} KB cap):
${SECTION_BULLETS}

Starting a session on a project:
1. kb_read <space>/<project>/overview/index.
2. kb_list the journal section to find the latest month note, then kb_read it with the tail option.
3. If you have access, kb_list and read the meta space (short notes on how the user works: preferences, conventions).

Working rules:
- Find notes with kb_search (or kb_list to browse).
- kb_history shows a note's git history (who changed what, when), following archive moves.
- Keep notes short and focused: one topic per note, link to related notes.
- Add journal entries with kb_append (journal/YYYY-MM); it writes one timestamped line.
- When you add an important note, update the Docs map in overview/index. Keep that note small; move detail elsewhere.
- Archive instead of delete: kb_archive (needs read and write on the section, plus write on the archive section).
- New project: kb_init_project creates overview/index from a template.
- If unsure whether something deserves a note, prefer a short journal entry, or use \`kb_propose\` (needs propose or write); the user reviews proposals.
- Space \`agents\` is per-agent scratch working memory (agents/<agent-name>), kept small by limits on notes and sizes and by auto-archive of stale notes. Keep its overview/index up to date: it is the handover note another agent resumes from. Durable knowledge belongs in the real project (kb_propose or kb_write), not in agents.
- Writes (kb_write) are direct and committed to git; re-read before overwriting a note you did not just read.`;
