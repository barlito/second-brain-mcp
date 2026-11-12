import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listNoteNames, readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath } from "../vault/paths";
import { RegisterTool, registerKbTool, toolError, toolText } from "./common";
import { snippet } from "./snippet";
import { discoveryCall, optSlug, readableSections } from "./discovery";

export const MAX_HIT_FILES = 50;
export const MAX_LINES_PER_FILE = 3;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SCANNED_FILES = 5000;
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;

// Mutable so tests can shrink them.
export const limits = {
  maxScannedFiles: MAX_SCANNED_FILES,
  deadlineMs: 3000,
  maxTotalBytes: 20 * 1024 * 1024,
};

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_search",
    {
      description:
        "Case-insensitive plain-text substring search over the notes this token can read. " +
        "Optionally narrow by space/project/section. Returns up to 50 notes with up to 3 matching lines each. " +
        "Archived notes are skipped unless include_archived is true or section 'archive' is requested explicitly.",
      inputSchema: {
        query: z.string().max(MAX_QUERY, `must be at most ${MAX_QUERY} characters`).describe("Text to find (2-200 chars)"),
        space: optSlug("space"),
        project: optSlug("project"),
        section: optSlug("section"),
        include_archived: z.boolean().optional().describe("Also search the 'archive' section (default false)"),
      },
    },
    async ({ query, space, project, section, include_archived }): Promise<CallToolResult> =>
      discoveryCall("kb_search", { space, project, section }, async (ctx) => {
        const trimmed = query.trim();
        const needle = trimmed.toLowerCase();
        if (needle.length < MIN_QUERY) {
          return {
            toolResult: toolError(`Query must be at least ${MIN_QUERY} characters.`),
            audit: { detail: `qlen=${trimmed.length} too short` },
          };
        }

        const out: string[] = [];
        const stats = { skipped: 0 };
        const started = Date.now();
        let files = 0;
        let scanned = 0;
        let bytes = 0;
        let truncated: string | undefined;

        scan: for await (const sec of readableSections(vaultRoot, ctx.scopes, { space, project, section }, include_archived === true, stats)) {
          let names: string[];
          try {
            names = await listNoteNames(vaultRoot, [sec.space, sec.project, sec.section]);
          } catch {
            stats.skipped++;
            continue;
          }
          for (const name of names) {
            if (Date.now() - started >= limits.deadlineMs) {
              truncated = "time limit reached";
              break scan;
            }
            if (bytes >= limits.maxTotalBytes) {
              truncated = "read limit reached";
              break scan;
            }
            if (++scanned > limits.maxScannedFiles) {
              truncated = "too many notes";
              break scan;
            }
            let content: string;
            try {
              const p = resolveNotePath(vaultRoot, sec.space, sec.project, sec.section, name);
              // One fd, O_NOFOLLOW: a swap to a symlink after listing is never followed.
              const r = await readFileNoFollow(p, MAX_FILE_BYTES);
              if (!r) {
                // Over the size cap (or no longer a regular file): say so instead of dropping it silently.
                stats.skipped++;
                continue;
              }
              content = r.content;
              bytes += r.bytes;
            } catch {
              stats.skipped++;
              continue;
            }

            const lines: string[] = [];
            for (const line of content.split("\n")) {
              if (!line.toLowerCase().includes(needle)) continue;
              lines.push(snippet(line, needle));
              if (lines.length >= MAX_LINES_PER_FILE) break;
            }
            if (!lines.length) continue;

            if (files >= MAX_HIT_FILES) {
              truncated = "more notes match";
              break scan;
            }
            files++;
            for (const l of lines) out.push(`${sec.space}/${sec.project}/${sec.section}/${name}: ${l}`);
          }
        }

        let text = out.length ? out.join("\n") : "No matches.";
        if (truncated) text += `\n(truncated: ${truncated}; results may be incomplete, narrow the search)`;
        if (stats.skipped) text += `\n(skipped ${stats.skipped} unreadable or oversized entries)`;
        const detail =
          `qlen=${trimmed.length} hits=${files}` +
          (truncated ? ` truncated(${truncated})` : "") +
          (stats.skipped ? ` skipped=${stats.skipped}` : "");
        return { toolResult: toolText(text), audit: { detail } };
      }),
  );
};
