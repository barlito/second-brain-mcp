import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { baseVersionArg, kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, withAclAndAudit } from "./common";
import { AGENTS_SPACE_RULE, DOCS_MAP_RULE, ENTRY_NOTE_MAX_BYTES, RESERVED_SECTIONS_SUMMARY } from "./conventions";
import { rejectReservedSection } from "./reserved";
import { NOTE_TYPES } from "./frontmatter";
import { writeNote } from "./writeNote";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_write",
    {
      description:
        "Write (create or overwrite) a note in the shared knowledge base vault. " +
        `Notes outside overview/journal/archive get a YAML frontmatter (type: ${NOTE_TYPES.join("|")}, sources, author, created, updated); ` +
        "you may send content with or without it: the server sets author/created/updated, defaults type from the section " +
        "(decisions, conventions, notes) and keeps `sources` (optional list of up to 20 strings, e.g. URLs) and other keys. " +
        "Content without frontmatter keeps the existing note's type, sources and other keys (only the body changes); content with frontmatter replaces them. " +
        "Recommended: set `sources` to where the knowledge comes from. " +
        "Writes are direct git commits: pass `base_version` (from kb_read; it proves you saw the latest version, not that you read it all) when overwriting a note so a concurrent change is not lost; prefer kb_edit for partial changes. " +
        "Keep notes short and focused (one topic per note, link related notes). " +
        `${DOCS_MAP_RULE} ${RESERVED_SECTIONS_SUMMARY} overview/index is capped at ${ENTRY_NOTE_MAX_BYTES} bytes. ` +
        AGENTS_SPACE_RULE,
      inputSchema: {
        ...kbArgsShape,
        content: z
          .string()
          .max(MAX_CONTENT_CHARS, "too large (max 512 KB)")
          .describe("Full note content (optionally starting with a YAML frontmatter)"),
        base_version: baseVersionArg,
        allow_shrink: z
          .boolean()
          .optional()
          .describe("Allow replacing a body of 1 KB or more by less than half of it (refused otherwise)"),
      },
    },
    async ({ space, project, section, note, content, base_version, allow_shrink }): Promise<CallToolResult> =>
      withAclAndAudit("kb_write", { space, project, section, note }, "write", async (ctx) => {
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
        return writeNote(
          vaultRoot,
          { space, project, section, note },
          content,
          `kb_write: ${space}/${project}/${section}/${note} via ${ctx.name}`,
          { author: ctx.name, baseVersion: base_version, guardShrink: !allow_shrink },
        );
      }),
  );
};
