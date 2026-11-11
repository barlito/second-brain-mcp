import { toolError, ToolRunResult } from "./common";

// Sections only a dedicated tool may write to.
export const ARCHIVE_SECTION = "archive";
export const ARCHIVE_PURPOSE = "where `kb_archive` moves notes; only kb_archive writes there";

// Direct writers (kb_write, kb_append) call this after the ACL check; null = allowed.
export function rejectReservedSection(section: string): ToolRunResult | null {
  if (section !== ARCHIVE_SECTION) return null;
  return {
    toolResult: toolError("Section `archive` is managed by kb_archive and cannot be written directly."),
    audit: { detail: "reserved section" },
  };
}
