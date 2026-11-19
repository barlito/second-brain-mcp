import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listSubdirs } from "../vault/enumerate";
import { runGit } from "../vault/git";
import { docsMapPaths } from "../vault/docsMap";
import { createResolver, LinkResolver, NoteRef, noteKey, parseLinks } from "../vault/links";
import { parseNote } from "./frontmatter";
import { projectArg, RegisterTool, registerKbTool, spaceArg, toolError, toolText, PERMISSION_DENIED } from "./common";
import { discoveryCall, readableSections } from "./discovery";
import { listReadableNotes, ScanBudget, scanNotice } from "./linkScan";
import { ARCHIVE_SECTION } from "./reserved";

export const DEFAULT_STALE_DAYS = 180;
export const MAX_LINT_ITEMS = 50;
const DAY_MS = 86400000;
// Sections outside the orphan and stale checks.
const SKIP_HEALTH = new Set(["overview", "journal"]);
const INDEX = { section: "overview", name: "index" };

interface Findings {
  broken: string[];
  ambiguous: string[];
  incoming: Set<string>;
  mentioned: Set<string>;
  missingMapEntries: string[];
  updated: Map<string, string | undefined>;
}

function updatedOf(content: string): string | undefined {
  try {
    const u = parseNote(content).data.updated;
    return typeof u === "string" && !Number.isNaN(Date.parse(u)) ? u : undefined;
  } catch {
    return undefined;
  }
}

async function gitDate(vaultRoot: string, n: NoteRef): Promise<string | undefined> {
  try {
    const out = await runGit(["log", "-1", "--format=%cI", "--", `${n.space}/${n.project}/${n.section}/${n.name}.md`], vaultRoot);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Records links of one note: incoming edges into the project and, for project notes, broken/ambiguous ones.
function scanLinks(src: NoteRef, content: string, resolve: LinkResolver, inProject: Set<string>, f: Findings): void {
  const own = inProject.has(noteKey(src));
  for (const l of parseLinks(content)) {
    const r = resolve(src, l.target);
    if (r.status === "resolved") {
      if (noteKey(r.note) !== noteKey(src) && inProject.has(noteKey(r.note))) f.incoming.add(noteKey(r.note));
      if (own && src.section === INDEX.section && src.name === INDEX.name) f.mentioned.add(noteKey(r.note));
    } else if (own && r.status === "missing") f.broken.push(`${noteKey(src)}: ${l.raw}`);
    else if (own && r.status === "ambiguous") {
      f.ambiguous.push(`${noteKey(src)}: ${l.raw} -> ${r.candidates.map(noteKey).join(", ")}`);
    }
  }
}

function docsMap(src: NoteRef, content: string, resolve: LinkResolver, f: Findings): void {
  for (const p of docsMapPaths(content)) {
    const r = resolve(src, p);
    if (r.status === "resolved") f.mentioned.add(noteKey(r.note));
    else if (r.status === "missing") f.missingMapEntries.push(`\`${p}\``);
  }
}

const group = (title: string, items: string[]): string =>
  items.length
    ? `${title} (${items.length})\n` +
      items.slice(0, MAX_LINT_ITEMS).map((i) => `- ${i}`).join("\n") +
      (items.length > MAX_LINT_ITEMS ? `\n- ... and ${items.length - MAX_LINT_ITEMS} more` : "")
    : "";

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_lint",
    {
      description:
        "Check the link health of a project (readable sections only): broken and ambiguous wikilinks, " +
        "Docs map entries pointing to missing notes, notes missing from the Docs map of overview/index, " +
        "orphans (no incoming link, not in the Docs map) and stale notes (frontmatter `updated` older than stale_days). " +
        "Overview, journal and archive are not checked for orphans/staleness. `No issues.` when clean.",
      inputSchema: {
        space: spaceArg,
        project: projectArg,
        stale_days: z.number().int().min(1).max(3650).optional().describe(`Stale threshold in days (default ${DEFAULT_STALE_DAYS})`),
      },
    },
    async ({ space, project, stale_days }): Promise<CallToolResult> =>
      discoveryCall("kb_lint", { space, project }, async (ctx) => {
        const budget = new ScanBudget(vaultRoot);
        const sections = [];
        for await (const s of readableSections(vaultRoot, ctx.scopes, { space, project }, false, budget)) sections.push(s);
        if (!sections.length) return { toolResult: toolError(PERMISSION_DENIED), audit: { detail: "nothing readable" } };
        let partial = false;
        try {
          partial = (await listSubdirs(vaultRoot, [space, project])).filter((s) => s !== ARCHIVE_SECTION).length > sections.length;
        } catch {
          budget.skipped++;
        }

        const all = await listReadableNotes(vaultRoot, ctx.scopes, {}, false, budget);
        const resolve = createResolver(all);
        const mine = all.filter((n) => n.space === space && n.project === project);
        const inProject = new Set(mine.map(noteKey));
        const f: Findings = { broken: [], ambiguous: [], incoming: new Set(), mentioned: new Set(), missingMapEntries: [], updated: new Map() };
        let hasIndex = false;

        // Project notes first, so the per-project reports stay complete when the caps cut the rest.
        for (const src of [...mine, ...all.filter((n) => !inProject.has(noteKey(n)))]) {
          const content = await budget.read(src);
          if (content === undefined) {
            if (budget.truncated) break;
            continue;
          }
          scanLinks(src, content, resolve, inProject, f);
          if (!inProject.has(noteKey(src))) continue;
          f.updated.set(noteKey(src), updatedOf(content));
          if (src.section === INDEX.section && src.name === INDEX.name) {
            hasIndex = true;
            docsMap(src, content, resolve, f);
          }
        }

        const limit = Date.now() - (stale_days ?? DEFAULT_STALE_DAYS) * DAY_MS;
        const stale: string[] = [];
        for (const n of mine) {
          const key = noteKey(n);
          if (SKIP_HEALTH.has(n.section) || !f.updated.has(key)) continue;
          const date = f.updated.get(key) ?? (budget.exhausted() ? undefined : await gitDate(vaultRoot, n));
          if (date !== undefined && Date.parse(date) < limit) stale.push(`${key} (updated ${date.slice(0, 10)})`);
        }

        const checked = mine.filter((n) => !SKIP_HEALTH.has(n.section));
        const unlisted = hasIndex ? checked.filter((n) => !f.mentioned.has(noteKey(n))).map(noteKey) : [];
        // With the scan cut short, a missing incoming link proves nothing.
        const orphans = budget.truncated ? [] : checked.filter((n) => !f.incoming.has(noteKey(n)) && !f.mentioned.has(noteKey(n))).map(noteKey);
        const groups = [
          group("Broken links", f.broken),
          group("Ambiguous links", f.ambiguous),
          group("Docs map: entries pointing to missing notes", f.missingMapEntries),
          group("Docs map: notes not listed", unlisted),
          group("Orphans", orphans),
          group("Stale notes", stale),
        ].filter(Boolean);
        const total = f.broken.length + f.ambiguous.length + f.missingMapEntries.length + unlisted.length + orphans.length + stale.length;

        let text = groups.length ? `${groups.join("\n\n")}\n\n${total} issue(s).` : "No issues.";
        if (!hasIndex) text += "\n(Docs map not checked: overview/index not found or not readable)";
        if (partial) text += "\n(some sections of this project are not readable by this token and were skipped)";
        text += scanNotice(budget);
        const detail = `issues=${total}` + (budget.truncated ? ` truncated(${budget.truncated})` : "") + (budget.skipped ? ` skipped=${budget.skipped}` : "");
        return { toolResult: toolText(text), audit: { detail } };
      }),
  );
};
