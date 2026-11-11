import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listNotes } from "../vault/enumerate";
import { resolveNotePath, UnsafePathError } from "../vault/paths";
import { RegisterTool, toolError, toolText } from "./common";
import { discoveryCall, optSlug, readableSections } from "./discovery";

export const MAX_HIT_FILES = 50;
export const MAX_LINES_PER_FILE = 3;
export const MAX_LINE_CHARS = 200;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SCANNED_FILES = 5000;
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;

export const register: RegisterTool = (server, { vaultRoot }) => {
  server.registerTool(
    "kb_search",
    {
      description:
        "Case-insensitive plain-text substring search over the notes this token can read. " +
        "Optionally narrow by space/project/section. Returns up to 50 notes with up to 3 matching lines each. " +
        "Archived notes are skipped unless include_archived is true.",
      inputSchema: {
        query: z.string().max(MAX_QUERY, `query must be at most ${MAX_QUERY} characters`).describe("Text to find (2-200 chars)"),
        space: optSlug("space"),
        project: optSlug("project"),
        section: optSlug("section"),
        include_archived: z.boolean().optional().describe("Also search the 'archive' section (default false)"),
      },
    },
    async ({ query, space, project, section, include_archived }): Promise<CallToolResult> =>
      discoveryCall("kb_search", { space, project, section }, (ctx) => {
        const needle = query.trim().toLowerCase();
        if (needle.length < MIN_QUERY) {
          return { result: toolError(`Query must be at least ${MIN_QUERY} characters.`), detail: `qlen=${query.length} too short` };
        }

        const out: string[] = [];
        let files = 0;
        let scanned = 0;
        let truncated = false;

        scan: for (const sec of readableSections(vaultRoot, ctx, { space, project, section }, include_archived === true)) {
          for (const n of listNotes(vaultRoot, [sec.space, sec.project, sec.section])) {
            if (++scanned > MAX_SCANNED_FILES) {
              truncated = true;
              break scan;
            }
            let content: string;
            try {
              const p = resolveNotePath(vaultRoot, sec.space, sec.project, sec.section, n.name);
              const st = lstatSync(p);
              if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
              content = readFileSync(p, "utf8");
            } catch (err) {
              if (err instanceof UnsafePathError || (err as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw err;
            }

            const lines: string[] = [];
            for (const line of content.split("\n")) {
              if (!line.toLowerCase().includes(needle)) continue;
              const t = line.trim();
              lines.push(t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}...` : t);
              if (lines.length >= MAX_LINES_PER_FILE) break;
            }
            if (!lines.length) continue;

            if (files >= MAX_HIT_FILES) {
              truncated = true;
              break scan;
            }
            files++;
            for (const l of lines) out.push(`${sec.space}/${sec.project}/${sec.section}/${n.name}: ${l}`);
          }
        }

        let text = out.length ? out.join("\n") : "No matches.";
        if (truncated) text += "\n(truncated: more notes may match, narrow the search)";
        return { result: toolText(text), detail: `qlen=${query.length} hits=${files}${truncated ? " truncated" : ""}` };
      }),
  );
};
