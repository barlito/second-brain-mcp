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

// path -> seconds of its last commit, one `git log` pass (newest first: first occurrence wins).
async function lastCommitTimes(vaultRoot: string, space: string): Promise<Map<string, number>> {
  const out = await runGit(["log", "--format=%ct", "--name-only", "--", space], vaultRoot);
  const times = new Map<string, number>();
  let ts = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (/^\d+$/.test(line)) ts = Number(line); // paths always contain a "/"
    else if (!times.has(line)) times.set(line, ts);
  }
  return times;
}

// Paths (untracked ones listed individually) with uncommitted changes under `spec`.
async function dirtyPaths(vaultRoot: string, spec: string[]): Promise<Set<string>> {
  const out = await runGit(["status", "--porcelain", "--untracked-files=all", "--", ...spec], vaultRoot);
  const dirty = new Set<string>();
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    for (const p of line.slice(3).split(" -> ")) dirty.add(p.replace(/^"|"$/g, ""));
  }
  return dirty;
}

export interface AutoArchiveResult {
  moved: number;
  commitSha?: string;
  skipped?: boolean;
}

interface Candidate {
  from: string;
  to: string;
  rel: string;
  ts: number;
  label: string;
}

// One run. `now` is injectable for tests. The expensive scan happens outside the write lock;
// inside it only the candidates are re-validated (still old, still clean, still there).
export async function runAutoArchive(vaultRoot: string, now: number = Date.now()): Promise<AutoArchiveResult> {
  const spaces = [...getSpaceLimits()].filter(([, l]) => l.archiveAfterDays !== undefined);
  if (spaces.length === 0) return { moved: 0 };
  const cutoffs = new Map(spaces.map(([space, l]) => [space, now - (l.archiveAfterDays as number) * DAY_MS]));

  const candidates: Candidate[] = [];
  const dirty = await dirtyPaths(vaultRoot, spaces.map(([s]) => s));
  for (const [space] of spaces) {
    const times = await lastCommitTimes(vaultRoot, space);
    for (const project of await listSubdirs(vaultRoot, [space])) {
      const taken = new Set<string>();
      for (const section of await listSubdirs(vaultRoot, [space, project])) {
        if (section === ARCHIVE_SECTION) continue;
        for (const note of await listNoteNames(vaultRoot, [space, project, section])) {
          if (section === OVERVIEW_SECTION && note === ENTRY_NOTE) continue;
          const from = resolveNotePath(vaultRoot, space, project, section, note);
          const rel = path.relative(vaultRoot, from);
          const ts = times.get(rel);
          // Never committed or uncommitted edits (a human at work) count as fresh.
          if (ts === undefined || dirty.has(rel) || ts * 1000 >= (cutoffs.get(space) as number)) continue;
          let to: string | undefined;
          for (let n = 1; n <= 50 && !to; n++) {
            const cand = resolveNotePath(vaultRoot, space, project, ARCHIVE_SECTION, archiveName(section, note, n));
            if (!taken.has(cand) && !(await exists(cand))) to = cand;
          }
          if (!to) continue;
          taken.add(to);
          candidates.push({ from, to, rel, ts, label: `${space}/${project}/${section}/${note}` });
        }
      }
    }
  }
  if (candidates.length === 0) return { moved: 0 };

  const names: string[] = [];
  const r = await syncMoveBatch(
    vaultRoot,
    async () => {
      const nowDirty = await dirtyPaths(vaultRoot, spaces.map(([s]) => s));
      const moves: Array<{ from: string; to: string }> = [];
      for (const c of candidates) {
        if (nowDirty.has(c.rel) || !(await exists(c.from)) || (await exists(c.to))) continue;
        // A commit may have landed since the scan (pull or write): re-read this one note's time.
        const last = Number((await runGit(["log", "-1", "--format=%ct", "--", c.rel], vaultRoot)).trim());
        if (!last || last !== c.ts) continue;
        moves.push({ from: c.from, to: c.to });
        names.push(c.label);
      }
      return moves;
    },
    `auto-archive: ${spaces.map(([s]) => s).join(", ")} (notes older than the configured age) via ${SYSTEM_ACTOR}`,
  );
  if (r === "skipped") {
    console.log("auto-archive: skipped, the pull before it did not happen or failed");
    return { moved: 0, skipped: true };
  }
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

const MAX_TIMER_MS = 2 ** 31 - 1;

// AUTO_ARCHIVE_INTERVAL_MS: unset/empty = daily, 0 = disabled; throws on anything else invalid
// (checked at boot; a timer above 2^31-1 ms would fire immediately).
export function parseAutoArchiveInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > MAX_TIMER_MS) {
    throw new Error(`AUTO_ARCHIVE_INTERVAL_MS must be an integer between 0 and ${MAX_TIMER_MS}, got "${raw}"`);
  }
  return Number(raw);
}

export function autoArchiveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseAutoArchiveInterval(env.AUTO_ARCHIVE_INTERVAL_MS);
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
