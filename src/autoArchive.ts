// Periodic job: moves notes untouched for `archiveAfterDays` (SPACE_LIMITS) to the project's
// archive section, the same move as kb_archive, in one commit per run.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { logAudit } from "./audit";
import { getSpaceLimits } from "./limits";
import { archiveName } from "./tools/archiveNote";
import { ENTRY_NOTE, OVERVIEW_SECTION } from "./tools/conventions";
import { ARCHIVE_SECTION } from "./tools/reserved";
import { listNoteNames, listSubdirs } from "./vault/enumerate";
import { errorMessage, safeAudit } from "./tools/common";
import { redact, runGit, syncMoveBatch } from "./vault/git";
import { resolveNotePath } from "./vault/paths";

export const SYSTEM_ACTOR = "system";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = DAY_MS;

// Seconds of the last commit touching `rel`; undefined when it was never committed.
async function lastCommitSec(vaultRoot: string, rel: string): Promise<number | undefined> {
  const out = (await runGit(["log", "-1", "--format=%ct", "--", rel], vaultRoot)).trim();
  return out ? Number(out) : undefined;
}

export interface AutoArchiveResult {
  moved: number;
  commitSha?: string;
}

// One run. `now` is injectable for tests.
export async function runAutoArchive(vaultRoot: string, now: number = Date.now()): Promise<AutoArchiveResult> {
  const spaces = [...getSpaceLimits()].filter(([, l]) => l.archiveAfterDays !== undefined);
  if (spaces.length === 0) return { moved: 0 };
  const names: string[] = [];
  const r = await syncMoveBatch(
    vaultRoot,
    async () => {
      const moves: Array<{ from: string; to: string }> = [];
      for (const [space, limits] of spaces) {
        const cutoff = now - (limits.archiveAfterDays as number) * DAY_MS;
        for (const project of await listSubdirs(vaultRoot, [space])) {
          const taken = new Set<string>();
          for (const section of await listSubdirs(vaultRoot, [space, project])) {
            if (section === ARCHIVE_SECTION) continue;
            for (const note of await listNoteNames(vaultRoot, [space, project, section])) {
              if (section === OVERVIEW_SECTION && note === ENTRY_NOTE) continue;
              const from = resolveNotePath(vaultRoot, space, project, section, note);
              const rel = path.relative(vaultRoot, from);
              // Uncommitted edits (a human at work) count as fresh.
              if ((await runGit(["status", "--porcelain", "--", rel], vaultRoot)).trim() !== "") continue;
              const ts = await lastCommitSec(vaultRoot, rel);
              if (ts === undefined || ts * 1000 >= cutoff) continue;
              let to: string | undefined;
              let name = "";
              for (let n = 1; n <= 50 && !to; n++) {
                name = archiveName(section, note, n);
                const cand = resolveNotePath(vaultRoot, space, project, ARCHIVE_SECTION, name);
                if (!taken.has(cand) && !(await exists(cand))) to = cand;
              }
              if (!to) continue;
              taken.add(to);
              moves.push({ from, to });
              names.push(`${space}/${project}/${section}/${note}`);
            }
          }
        }
      }
      return moves;
    },
    `auto-archive: ${spaces.map(([s]) => s).join(", ")} (notes older than the configured age) via ${SYSTEM_ACTOR}`,
  );
  if (!r) return { moved: 0 };
  safeAudit(
    {
      tokenId: SYSTEM_ACTOR,
      tokenName: SYSTEM_ACTOR,
      action: "auto_archive",
      result: "ok",
      detail: `${r.moved} note(s): ${names.join(", ")}`,
      gitCommit: r.commitSha || undefined,
    },
    SYSTEM_ACTOR,
  );
  return { moved: r.moved, commitSha: r.commitSha };
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

export function autoArchiveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTO_ARCHIVE_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

// Runs once shortly after start, then every interval. Returns a stop function; no-op (and
// returns undefined) when no space sets archiveAfterDays or the interval is 0.
export function startAutoArchive(vaultRoot: string, intervalMs = autoArchiveIntervalMs()): (() => void) | undefined {
  if (intervalMs <= 0 || ![...getSpaceLimits().values()].some((l) => l.archiveAfterDays !== undefined)) return undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await runAutoArchive(vaultRoot);
      if (r.moved > 0) console.log(`auto-archive: moved ${r.moved} note(s) (${r.commitSha?.slice(0, 12)})`);
    } catch (err) {
      console.error(`auto-archive failed: ${redact(errorMessage(err))}`);
      try {
        logAudit({ tokenId: SYSTEM_ACTOR, tokenName: SYSTEM_ACTOR, action: "auto_archive", result: "error", detail: redact(errorMessage(err)) });
      } catch {
        /* never throw from a timer */
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
