import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { kbArgsShape, RegisterTool, registerKbTool, Target, toolText, withAclAndAudit } from "./common";
import { readNote } from "./kbRead";

export const MAX_MANY_OUTPUT_BYTES = 1024 * 1024;
export const SKIPPED = "(skipped: output limit reached, read it separately)";

const itemSchema = z.object(kbArgsShape);

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_read_many",
    {
      description:
        "Read 1-20 notes in one call (same rules and errors as kb_read, each item checked and audited on its own). " +
        "Optional `tail` (1-500) applies to every note. Output: one `## space/project/section/note` block per item, " +
        "with the content or its error; output is capped at 1 MiB, later items are skipped.",
      inputSchema: {
        notes: z.array(itemSchema).min(1).max(20).describe("Notes to read: {space, project, section, note}"),
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of each note"),
      },
    },
    async ({ notes, tail }): Promise<CallToolResult> => {
      const blocks: string[] = [];
      let used = 0;
      let full = false;
      for (const t of notes as Target[]) {
        const head = `## ${t.space}/${t.project}/${t.section}/${t.note}\n`;
        let block = head + SKIPPED;
        if (!full) {
          const read = head + (await readOne(vaultRoot, t, tail));
          if (used + Buffer.byteLength(read) <= MAX_MANY_OUTPUT_BYTES) {
            block = read;
            used += Buffer.byteLength(read);
          } else full = true;
        }
        blocks.push(block);
      }
      return toolText(blocks.join("\n\n"));
    },
  );
};

// One audit row per item: each goes through the same gate and audited path as kb_read.
async function readOne(vaultRoot: string, t: Target, tail?: number): Promise<string> {
  const r = await withAclAndAudit("kb_read_many", t, "read", () => readNote(vaultRoot, t, tail));
  const first = r.content[0];
  return first.type === "text" ? first.text : "";
}
