import { promises as fsp } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveNotePath } from "../vault/paths";
import { kbArgsShape, RegisterTool, registerKbTool, Target, toolError, toolText, withAclAndAudit } from "./common";
import { readNote } from "./kbRead";

export const MAX_MANY_OUTPUT_BYTES = 1024 * 1024;
export const SKIPPED = "(skipped: output limit reached, read it separately)";

const itemSchema = z.object(kbArgsShape);
const bytes = (s: string) => Buffer.byteLength(s);
// Raw input may hold newlines or markers: only echo a harmless form in the headers.
const safe = (v: string) => v.replace(/[^A-Za-z0-9-]/g, "?").slice(0, 64);

interface Item {
  text: string;
  refused?: CallToolResult; // set when the gate stopped the item (nothing ran)
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_read_many",
    {
      description:
        "Read 1-20 notes in one call (same rules and errors as kb_read, each item checked and audited on its own). " +
        "Optional `tail` (1-500) applies to every note. Output: one `## space/project/section/note` block per item, " +
        "with the content or its error; output is capped at 1 MiB, items that no longer fit are skipped.",
      inputSchema: {
        notes: z.array(itemSchema).min(1).max(20).describe("Notes to read: {space, project, section, note}"),
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of each note"),
      },
    },
    async ({ notes, tail }): Promise<CallToolResult> => {
      const blocks: string[] = [];
      const refusals: CallToolResult[] = [];
      let used = 0;
      for (const t of notes as Target[]) {
        const head = `## ${[t.space, t.project, t.section, t.note].map(safe).join("/")}\n`;
        const item = await readOne(vaultRoot, t, tail, MAX_MANY_OUTPUT_BYTES - used - bytes(head));
        if (item.refused) refusals.push(item.refused);
        const fits = bytes(head + item.text) <= MAX_MANY_OUTPUT_BYTES - used;
        const block = head + (fits ? item.text : SKIPPED);
        if (fits) used += bytes(block);
        blocks.push(block);
      }
      // Every item stopped by the gate (no access, bad names): one error, not 20 copies.
      if (refusals.length === notes.length) return refusals[0];
      return toolText(blocks.join("\n\n"));
    },
  );
};

// One audit row per item, through the same gate and audited path as kb_read.
async function readOne(vaultRoot: string, t: Target, tail: number | undefined, budget: number): Promise<Item> {
  let ran = false;
  const r = await withAclAndAudit("kb_read_many", t, "read", async () => {
    ran = true;
    // A note that cannot fit is skipped from its size alone (after the ACL), never read.
    if (tail === undefined) {
      const st = await fsp.lstat(resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note)).catch(() => undefined);
      if (st?.isFile() && st.size > budget) return { toolResult: toolError(SKIPPED), audit: { detail: `skipped: output limit (${st.size} bytes)` } };
    }
    return readNote(vaultRoot, t, tail);
  });
  const first = r.content[0];
  return { text: first.type === "text" ? first.text : "", refused: ran ? undefined : r };
}
