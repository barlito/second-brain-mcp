// KB organisation conventions: shared constants and the text shown to agents.

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
  { section: "archive", purpose: "where `kb_archive` moves notes; never written directly" },
];

export const RESERVED_SECTIONS_SUMMARY =
  "Reserved sections: overview (entry note `index`), decisions, conventions, notes, journal (monthly `YYYY-MM`), archive (written only by kb_archive).";

export function entryNoteTooLargeMessage(bytes: number): string {
  return (
    `overview/index is too large (${bytes} bytes, max ${ENTRY_NOTE_MAX_BYTES}). ` +
    "The entry note must stay small: move detail into other sections (decisions, conventions, notes) " +
    "and link to those notes from the Docs map."
  );
}

export function entryNoteTemplate(project: string, summary: string): string {
  const map = RESERVED_SECTIONS.filter((s) => s.section !== "overview")
    .map((s) => `- \`${s.section}\`: ${s.purpose}`)
    .join("\n");
  return `# ${project}\n\n${summary.trim()}\n\n## Docs map\n\n${map}\n\nAdd key notes here as they are created (link them under the right section).\n`;
}

export const SERVER_INSTRUCTIONS = `Shared knowledge base (git-backed vault). Layout: <space>/<project>/<section>/<note>.md. Spaces, projects, sections and notes are lowercase slugs (a-z, 0-9, hyphen). You only see what your token allows.

Reserved sections in every project:
- overview: entry note \`index\` = what the project is + a map of its docs. Hard size cap (${ENTRY_NOTE_MAX_BYTES / 1024} KB).
- decisions: why X was chosen; short ADR-style notes.
- conventions: how things are done in this project.
- notes: everything else.
- journal: monthly notes named YYYY-MM, short entries, added with kb_append.
- archive: where kb_archive moves notes. Never write there directly.

Starting a session on a project:
1. kb_read <space>/<project>/overview/index.
2. kb_read the latest journal note(s) with the tail option.
3. If you have access, read the meta space (short notes on how the user works: preferences, conventions) at the start of a session.

Working rules:
- Keep notes short and focused: one topic per note, link to related notes.
- When you add an important note, update the Docs map in overview/index. Keep that note small; move detail elsewhere.
- Archive instead of delete (kb_archive).
- New project: kb_init_project creates overview/index from a template.
- If unsure whether something deserves a note, prefer a short journal entry.
- Writes are direct (kb_write) and committed to git; re-read before overwriting a note you did not just read.`;
