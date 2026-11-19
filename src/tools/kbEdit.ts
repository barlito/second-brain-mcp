import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { baseVersionArg, kbArgsShape, RegisterTool, registerKbTool, withAclAndAudit } from "./common";
import { ENTRY_NOTE_MAX_BYTES, NoteRuleError } from "./conventions";
import { hasFrontmatter, parseNote } from "./frontmatter";
import { rejectReservedSection } from "./reserved";
import { writeNote } from "./writeNote";

export const MAX_EDITS = 20;

interface Edit {
  old_str: string;
  new_str: string;
}

const editError = (message: string): NoteRuleError => new NoteRuleError(message, message.replace(/^Edit \d+: /, "edit: "));

// Applies the edits in order, each on the result of the previous; all or nothing (throws NoteRuleError).
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  edits.forEach((e, i) => {
    const n = out.split(e.old_str).length - 1;
    if (n === 0) throw editError(`Edit ${i + 1}: old_str not found.`);
    if (n > 1) throw editError(`Edit ${i + 1}: old_str matches ${n} times; add surrounding text to make it unique.`);
    // Function replacer: `$` in new_str is literal.
    out = out.replace(e.old_str, () => e.new_str);
  });
  return out;
}

// Edits touch the body only; the frontmatter stays as it is (the write path then refreshes `updated`).
function editNote(section: string, existing: string | null, edits: Edit[]): string {
  if (existing === null) throw new NoteRuleError("Note not found.", "note not found");
  if (!hasFrontmatter(section)) return applyEdits(existing, edits);
  const { body } = parseNote(existing);
  return existing.slice(0, existing.length - body.length) + applyEdits(body, edits);
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_edit",
    {
      description:
        "Change part of an existing note by exact text replacement, without resending the whole note. " +
        `\`edits\` (1-${MAX_EDITS}) are applied in order, each on the text left by the previous one; every \`old_str\` must occur exactly once, otherwise nothing is written. ` +
        "Edits apply to the note body only: the frontmatter is managed by the server (use kb_write to change type or sources); " +
        "notes without frontmatter (overview, journal) are edited as a whole. " +
        "Pass `base_version` (from kb_read) so a concurrent change is not lost. Same rules as kb_write " +
        `(overview/index capped at ${ENTRY_NOTE_MAX_BYTES} bytes, space limits, section \`archive\` refused). Returns the commit SHA and the new version.`,
      inputSchema: {
        ...kbArgsShape,
        edits: z
          .array(
            z.object({
              old_str: z.string().min(1, "old_str must not be empty").describe("Exact text to replace; must occur once"),
              new_str: z.string().describe("Replacement text (may be empty)"),
            }),
          )
          .min(1)
          .max(MAX_EDITS, `too many edits (max ${MAX_EDITS})`),
        base_version: baseVersionArg,
      },
    },
    async ({ space, project, section, note, edits, base_version }): Promise<CallToolResult> =>
      withAclAndAudit("kb_edit", { space, project, section, note }, "write", async (ctx) => {
        const reserved = rejectReservedSection(section);
        if (reserved) return reserved;
        return writeNote(
          vaultRoot,
          { space, project, section, note },
          (existing) => editNote(section, existing, edits),
          `kb_edit: ${space}/${project}/${section}/${note} via ${ctx.name}`,
          { author: ctx.name, baseVersion: base_version },
        );
      }),
  );
};
