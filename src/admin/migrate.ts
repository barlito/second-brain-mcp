// One-off migration: add (or complete) frontmatter on existing notes, in ONE commit through
// the normal write queue. Runs inside the server (admin listener) like inbox accept/reject.
import path from "node:path";
import { listNoteNames, listSubdirs, readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath } from "../vault/paths";
import { runGit, syncBatchWrite } from "../vault/git";
import { fillMissingFrontmatter, hasFrontmatter, utcToday } from "../tools/frontmatter";
import { MAX_CONTENT_CHARS, safeAudit } from "../tools/common";
import { NoteRuleError } from "../tools/conventions";
import { assertSpaceLimits, SpaceLimitError } from "../limits";

export const MIGRATION_AUTHOR = "migration";
const MAX_READ_BYTES = 2 * 1024 * 1024;
// Whole-history scan of a big vault can take a while.
const LOG_TIMEOUT_MS = 10 * 60 * 1000;

export interface MigrationResult {
  commit: string | null;
  migrated: number;
  // Notes left alone (malformed frontmatter, uncommitted changes, ...), with the reason.
  skipped: string[];
}

// path -> [first, last] commit date (YYYY-MM-DD), from ONE `git log` over the whole vault.
async function commitDates(vaultRoot: string): Promise<Map<string, [string, string]>> {
  const out = await runGit(
    ["-c", "core.quotepath=off", "log", "--name-only", "--no-renames", "--format=@@%as"],
    vaultRoot,
    LOG_TIMEOUT_MS,
  ).catch(() => ""); // no commits yet
  const dates = new Map<string, [string, string]>();
  let date = "";
  // Newest first: slot 1 keeps the first sighting (last commit), slot 0 the final one (first commit).
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) date = line.slice(2);
    else if (line && date) {
      const cur = dates.get(line);
      if (cur) cur[0] = date;
      else dates.set(line, [date, date]);
    }
  }
  return dates;
}

// Vault-relative paths with staged, unstaged or untracked changes.
async function dirtyPaths(vaultRoot: string): Promise<Set<string>> {
  const out = await runGit(["status", "--porcelain", "-z", "--untracked-files=all"], vaultRoot);
  const set = new Set<string>();
  for (const e of out.split("\0")) if (e.length > 3) set.add(e.slice(3));
  return set;
}

export async function migrateFrontmatter(vaultRoot: string, actor: string): Promise<MigrationResult> {
  const history = await commitDates(vaultRoot);
  const skipped: string[] = [];
  const result = await syncBatchWrite(
    vaultRoot,
    async () => {
      skipped.length = 0;
      const items: Array<{ absolutePath: string; content: string }> = [];
      const today = utcToday();
      const dirty = await dirtyPaths(vaultRoot);
      // Growth per project of the items planned so far: the limits see the running total.
      const grown = new Map<string, number>();
      for (const space of await listSubdirs(vaultRoot, [])) {
        for (const project of await listSubdirs(vaultRoot, [space])) {
          for (const section of await listSubdirs(vaultRoot, [space, project])) {
            if (!hasFrontmatter(section)) continue;
            for (const note of await listNoteNames(vaultRoot, [space, project, section])) {
              const label = `${space}/${project}/${section}/${note}`;
              const abs = resolveNotePath(vaultRoot, space, project, section, note);
              const rel = path.relative(vaultRoot, abs).split(path.sep).join("/");
              try {
                const cur = await readFileNoFollow(abs, MAX_READ_BYTES);
                if (!cur) {
                  skipped.push(`${label}: not a regular file or too large`);
                  continue;
                }
                if (!Buffer.from(cur.content, "utf8").equals(cur.raw)) {
                  skipped.push(`${label}: not valid UTF-8`);
                  continue;
                }
                const h = history.get(rel);
                const content = fillMissingFrontmatter(cur.content, {
                  section,
                  author: MIGRATION_AUTHOR,
                  created: h?.[0] ?? today,
                  updated: h?.[1] ?? today,
                });
                if (content === cur.content) continue; // nothing missing
                if (dirty.has(rel)) {
                  skipped.push(`${label}: uncommitted changes in the vault`);
                  continue;
                }
                if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_CHARS) {
                  skipped.push(`${label}: would exceed the size limit`);
                  continue;
                }
                const size = Buffer.byteLength(content, "utf8");
                const pk = `${space}/${project}`;
                try {
                  assertSpaceLimits(vaultRoot, { space, project, section, note }, size, grown.get(pk) ?? 0);
                } catch (err) {
                  if (!(err instanceof SpaceLimitError)) throw err;
                  skipped.push(`${label}: ${err.message}`);
                  continue;
                }
                grown.set(pk, (grown.get(pk) ?? 0) + size - cur.raw.length);
                items.push({ absolutePath: abs, content });
              } catch (err) {
                if (!(err instanceof NoteRuleError)) throw err;
                skipped.push(`${label}: ${err.message}`);
              }
            }
          }
        }
      }
      return items;
    },
    "migrate: add frontmatter to existing notes",
  );
  safeAudit(
    {
      tokenId: actor,
      tokenName: actor,
      action: "migrate_frontmatter",
      result: "ok",
      detail: `migrated=${result.files} skipped=${skipped.length}`,
      gitCommit: result.commitSha ?? undefined,
    },
    actor,
  );
  return { commit: result.commitSha, migrated: result.files, skipped };
}
