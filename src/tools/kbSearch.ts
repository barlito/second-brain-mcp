import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listNoteNames, readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath } from "../vault/paths";
import { RegisterTool, registerKbTool, toolError, toolText, ToolRunResult } from "./common";
import { fold, snippet } from "./snippet";
import { parseQuery, SearchTerm, termIn, toMatch, words } from "./searchQuery";
import { getSearchIndex, MAX_INDEXED_BYTES, SearchIndex } from "../vault/searchIndex";
import { NOTE_TYPES, searchView } from "./frontmatter";
import { discoveryCall, optSlug, readableSections, ScopeArgs } from "./discovery";
import { TokenContext } from "../auth/context";

export const MAX_HIT_FILES = 50;
export const MAX_LINES_PER_FILE = 3;
export const MAX_FILE_BYTES = MAX_INDEXED_BYTES;
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
        "Ranked full-text search over the notes this token can read (case and accent insensitive). " +
        "Find notes by text (or browse with kb_list). Optionally narrow by space/project/section. Returns up to 50 notes, best first (a match in the note name ranks higher), with up to 3 matching lines each. " +
        'Words are ANDed; use "quoted phrase" for an exact phrase and a trailing * for a prefix (deci*). ' +
        "Matches the note name and body (frontmatter excluded); optional `type` keeps only notes whose frontmatter type matches. " +
        "Archived notes are skipped unless include_archived is true or section 'archive' is requested explicitly.",
      inputSchema: {
        query: z.string().max(MAX_QUERY, `must be at most ${MAX_QUERY} characters`).describe("Words to find (2-200 chars): word1 word2, \"exact phrase\", prefix*"),
        space: optSlug("space"),
        project: optSlug("project"),
        section: optSlug("section"),
        type: z.enum(NOTE_TYPES).optional().describe("Only notes whose frontmatter type matches"),
        include_archived: z.boolean().optional().describe("Also search the 'archive' section (default false)"),
      },
    },
    async ({ query, space, project, section, type, include_archived }): Promise<CallToolResult> =>
      discoveryCall("kb_search", { space, project, section }, async (ctx) => {
        const trimmed = query.trim();
        const needle = trimmed.toLowerCase();
        if (needle.length < MIN_QUERY) {
          return {
            toolResult: toolError(`Query must be at least ${MIN_QUERY} characters.`),
            audit: { detail: `qlen=${trimmed.length} too short` },
          };
        }

        const terms = parseQuery(trimmed);
        if (!terms.length) return { toolResult: toolError(NO_TERM), audit: { detail: `qlen=${trimmed.length} no term` } };
        const idx = getSearchIndex(vaultRoot);
        if (idx?.ready) return indexedSearch(idx, vaultRoot, ctx.scopes, trimmed, terms, { space, project, section, type }, include_archived === true);

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

            // Cheap substring test first: YAML is only parsed for notes that can match.
            if (!content.toLowerCase().includes(needle)) continue;
            const view = searchView(sec.section, content);
            if (type !== undefined && view.type !== type) continue;

            const lines: string[] = [];
            for (const line of view.body.split("\n")) {
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

const NO_TERM = "Query has no searchable word.";

// Same output format as the scan fallback. Rows are ranked over the whole vault but
// only readable sections are ever emitted or counted.
async function indexedSearch(
  idx: SearchIndex,
  vaultRoot: string,
  scopes: TokenContext["scopes"],
  trimmed: string,
  terms: SearchTerm[],
  f: ScopeArgs & { type?: string },
  includeArchived: boolean,
): Promise<ToolRunResult> {
  const stats = { skipped: 0 };
  const readable = new Set<string>();
  for await (const s of readableSections(vaultRoot, scopes, f, includeArchived, stats)) {
    readable.add(`${s.space}/${s.project}/${s.section}`);
  }

  const out: string[] = [];
  let files = 0;
  let truncated: string | undefined;
  try {
    for (const hit of idx.search(toMatch(terms), f)) {
      if (!readable.has(hit.path.slice(0, hit.path.lastIndexOf("/")))) continue;
      if (files >= MAX_HIT_FILES) {
        truncated = "more notes match";
        break;
      }
      files++;
      const lines = matchingLines(idx.body(hit.rowid), terms);
      if (!lines.length) lines.push(nameMatches(hit.path, terms) ? "(name match)" : "(match spans lines)");
      for (const l of lines) out.push(`${hit.path}: ${l}`);
    }
  } catch {
    return { toolResult: toolError("Invalid query."), audit: { detail: `qlen=${trimmed.length} invalid` } };
  }

  let text = out.length ? out.join("\n") : "No matches.";
  if (truncated) text += `\n(truncated: ${truncated}; results may be incomplete, narrow the search)`;
  if (stats.skipped) text += `\n(skipped ${stats.skipped} unreadable or oversized entries)`;
  const detail = `qlen=${trimmed.length} hits=${files} indexed` + (truncated ? ` truncated(${truncated})` : "");
  return { toolResult: toolText(text), audit: { detail } };
}

function nameMatches(notePath: string, terms: SearchTerm[]): boolean {
  const name = words(notePath.slice(notePath.lastIndexOf("/") + 1));
  return terms.some((t) => termIn(name, t));
}

function matchingLines(body: string, terms: SearchTerm[]): string[] {
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const w = words(line);
    const hit = terms.find((t) => termIn(w, t));
    if (!hit) continue;
    lines.push(snippet(line, hit.text.split(" ")[0]));
    if (lines.length >= MAX_LINES_PER_FILE) break;
  }
  return lines;
}
