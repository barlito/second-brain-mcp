import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { statNote } from "../vault/enumerate";
import { createResolver, lineAt, noteKey, parseLinks } from "../vault/links";
import { kbArgsShape, RegisterTool, registerKbTool, toolError, toolText, withAclAndAudit } from "./common";
import { snippet } from "./snippet";
import { listReadableNotes, ScanBudget, scanNotice } from "./linkScan";

export const MAX_BACKLINK_NOTES = 50;

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_backlinks",
    {
      description:
        "List the notes that link to a note with a wikilink ([[name]], [[section/name]], [[project/section/name]], [[space/project/section/name]], alias/heading/embed forms included). " +
        "Only notes this token can read are scanned; archived notes are skipped unless include_archived is true. " +
        "Output lines: `<space>/<project>/<section>/<note>: <line>`; `No backlinks.` if none.",
      inputSchema: {
        ...kbArgsShape,
        include_archived: z.boolean().optional().describe("Also scan the 'archive' section (default false)"),
      },
    },
    async ({ space, project, section, note, include_archived }): Promise<CallToolResult> =>
      withAclAndAudit("kb_backlinks", { space, project, section, note }, "read", async (ctx) => {
        if (!(await statNote(vaultRoot, [space, project, section], note))) {
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }
        const target = noteKey({ space, project, section, name: note });
        const budget = new ScanBudget(vaultRoot);
        const notes = await listReadableNotes(vaultRoot, ctx.scopes, {}, include_archived === true, budget);
        const resolve = createResolver(notes);
        const needle = note.toLowerCase();
        const out: string[] = [];
        for (const src of notes) {
          if (noteKey(src) === target) continue;
          const content = await budget.read(src);
          if (content === undefined) {
            if (budget.truncated) break;
            continue;
          }
          if (!content.toLowerCase().includes(needle)) continue;
          const hit = parseLinks(content).find((l) => {
            const r = resolve(src, l.target);
            return r.status === "resolved" && noteKey(r.note) === target;
          });
          if (!hit) continue;
          if (out.length >= MAX_BACKLINK_NOTES) {
            budget.truncated = "more notes link here";
            break;
          }
          out.push(`${noteKey(src)}: ${snippet(lineAt(content, hit.start), needle)}`);
        }
        const text = (out.length ? out.join("\n") : "No backlinks.") + scanNotice(budget);
        const detail = `backlinks=${out.length}` + (budget.truncated ? ` truncated(${budget.truncated})` : "") + (budget.skipped ? ` skipped=${budget.skipped}` : "");
        return { toolResult: toolText(text), audit: { detail } };
      }),
  );
};
