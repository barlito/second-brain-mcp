import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { baseVersionArg, kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, ToolRunResult, withAclAndAudit } from "./common";
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
    const at = out.indexOf(e.old_str);
    if (at < 0) throw editError(`Edit ${i + 1}: old_str not found.`);
    // Overlapping matches count too ("aa" in "aaa" is ambiguous).
    let n = 1;
    for (let next = out.indexOf(e.old_str, at + 1); next >= 0; next = out.indexOf(e.old_str, next + 1)) n++;
    if (n > 1) throw editError(`Edit ${i + 1}: old_str matches ${n} times; add surrounding text to make it unique.`);
    out = out.slice(0, at) + e.new_str + out.slice(at + e.old_str.length);
  });
  return out;
}

// Edits touch the body only; the frontmatter stays as it is (the write path then refreshes `updated`).
function editNote(section: string, existing: string | null, edits: Edit[]): string {
  if (existing === null) throw new NoteRuleError("Note not found.", "note not found");
  if (!hasFrontmatter(section)) return applyEdits(existing, edits);
  let body: string;
  try {
    ({ body } = parseNote(existing));
  } catch (err) {
    if (err instanceof NoteRuleError) throw new NoteRuleError(`${err.message} Fix the frontmatter with kb_write.`, err.detail);
    throw err;
  }
  return existing.slice(0, existing.length - body.length) + applyEdits(body, edits);
}

// The frontmatter itself is refused (e.g. a type the section forbids): kb_edit cannot repair it.
function withKbWriteHint(r: ToolRunResult): ToolRunResult {
  const block = r.toolResult.content[0];
  if (!r.audit?.detail?.startsWith("invalid frontmatter") || block.type !== "text" || block.text.includes("kb_write")) return r;
  return { ...r, toolResult: { ...r.toolResult, content: [{ type: "text", text: `${block.text} Fix the frontmatter with kb_write.` }] } };
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
              old_str: z.string().min(1, "old_str must not be empty").max(MAX_CONTENT_CHARS, "too large (max 512 KB)").describe("Exact text to replace; must occur once"),
              new_str: z.string().max(MAX_CONTENT_CHARS, "too large (max 512 KB)").describe("Replacement text (may be empty)"),
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
        const r = await writeNote(
          vaultRoot,
          { space, project, section, note },
          (existing) => editNote(section, existing, edits),
          `kb_edit: ${space}/${project}/${section}/${note} via ${ctx.name}`,
          { author: ctx.name, baseVersion: base_version },
        );
        return withKbWriteHint(r);
      }),
  );
};
