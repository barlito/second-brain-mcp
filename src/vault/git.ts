import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { assertSafePath } from "./paths";

const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 30_000;
// One overall deadline for a push including its retries and pulls. Every git
// child gets this signal, so nothing outlives the queue turn that waits on it.
// Env override exists for tests.
const DEFAULT_PUSH_DEADLINE_MS = 150_000;
const PUSH_RETRIES = 3;
const PUSH_BACKOFF_MS = 1000;
// An index.lock younger than this may belong to a live human git process.
const STALE_LOCK_MS = 10 * 60_000;
const REBASE_MARKER = "second-brain-rebase";
// Present in .git while this server runs a git operation that may take
// index.lock. If it is still there at startup, the previous process died
// mid-operation and any index.lock is ours to remove.
const OP_MARKER = "second-brain-op";

function pushDeadlineMs(): number {
  return Number(process.env.SB_PUSH_DEADLINE_MS) || DEFAULT_PUSH_DEADLINE_MS;
}

// LANG/LC_ALL=C: error-message matching must not depend on the locale.
// GIT_TERMINAL_PROMPT=0: never block waiting for credentials on a tty.
const GIT_ENV = { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

// The single git runner: every git child in the process goes through here.
export function runGit(
  args: string[],
  cwd: string,
  timeout = LOCAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", env: GIT_ENV, timeout, signal, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        Object.assign(err, { stdout, stderr });
        reject(err);
      },
    );
  });
}

// Resolves early (never rejects) when the signal aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Strips credentials from URLs before anything is logged.
export function redact(text: string): string {
  return text.replace(/:\/\/[^@/\s]+@/g, "://***@");
}

function errText(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return redact(`${e.message ?? String(err)} ${e.stderr ?? ""}`.trim());
}

// ---- errors --------------------------------------------------------------

// The remote changed the same notes as local unpushed work. The full local state
// was saved on a backup branch, the working branch reset to the remote, and the
// local commits that still applied cleanly were re-applied on top (`reapplied`).
// Only the conflicting ones are left parked on the backup branch. `paths` are
// the conflicting paths. The write that hit the conflict was NOT applied.
export class SyncConflictError extends Error {
  constructor(
    message: string,
    readonly backupBranch: string | null,
    readonly paths: string[],
    readonly reapplied = 0,
  ) {
    super(message);
    this.name = "SyncConflictError";
  }
}

// A human (or another git process) is using the repo; retry later.
export class VaultBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultBusyError";
  }
}

// Startup was interrupted by a signal between two bootstrap git steps.
export class BootstrapAbortedError extends Error {
  constructor() {
    super("bootstrap aborted by signal");
    this.name = "BootstrapAbortedError";
  }
}

// ---- sync status ---------------------------------------------------------

export type SyncErrorKind = "network" | "conflict" | "dirty" | "other";

export interface SyncStatus {
  unpushed: boolean;
  lastPushAt: string | null;
  lastPushOk: boolean | null;
  lastPullAt: string | null;
  lastError: { kind: SyncErrorKind; message: string; at: string } | null;
  conflictBranches: string[];
}

const statuses = new Map<string, SyncStatus>();

// Emitted once the backup branch exists and the local reset was attempted.
// Injected so this module never touches the DB layer.
export type SyncConflictOrigin = "write" | "push-retry" | "periodic";
export interface SyncConflictEvent {
  vaultRoot: string;
  origin: SyncConflictOrigin;
  backupBranch: string;
  ok: boolean; // false when recovery failed part-way after the backup branch was created
  error?: string;
  commits: string[]; // parked (not re-applied) commit SHAs, newest first
  tokens: string[]; // token names parsed from the parked commits' subjects (server's own subjects only)
  paths: string[]; // conflicting paths
  parked?: ParkedCommit[]; // parked commits, oldest first
  reapplied?: number; // local commits that applied cleanly and stay on the branch
}
export interface ParkedCommit {
  sha: string;
  subject: string;
  paths: string[]; // paths the commit changed
}
type SyncEventHandler = (e: SyncConflictEvent) => void | Promise<void>;
let syncEventHandler: SyncEventHandler | null = null;
export function setSyncEventHandler(fn: SyncEventHandler | null): void {
  syncEventHandler = fn;
}

// Fire-and-forget: neither a sync throw nor an async rejection may reach the
// git path or crash the process.
function emitSyncEvent(e: SyncConflictEvent): void {
  const handler = syncEventHandler;
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(e))
    .catch((err) => console.error(`sync event handler failed: ${errText(err)}`));
}

// Only the exact subjects this server emits: "<tool>: <target> via <token name>".
const TOKEN_SUBJECT_RE =
  /^(?:kb_write|kb_append|kb_archive|kb_init_project|kb_propose|inbox accept): \S+ via ([A-Za-z0-9._-]{1,64})$/;

// conflict/* branches that still exist locally; cached so status reads stay
// cheap. Only the user deletes them.
let conflictTtlMs = 30_000;
export function setConflictCacheTtlMs(ms: number): void {
  conflictTtlMs = ms;
}
const conflictCheckedAt = new Map<string, number>();
const conflictRefreshing = new Map<string, Promise<void>>();
// Branches added while a refresh is in flight (its for-each-ref result may predate them).
const addedDuringRefresh = new Map<string, Set<string>>();

function addConflictBranch(vaultRoot: string, branch: string): void {
  const key = path.resolve(vaultRoot);
  const list = st(vaultRoot).conflictBranches;
  if (!list.includes(branch)) list.push(branch);
  addedDuringRefresh.get(key)?.add(branch);
  conflictCheckedAt.set(key, 0); // next status read re-lists
}

// Refreshes st(vaultRoot).conflictBranches from the repo if the cache is stale.
// Concurrent callers share one in-flight refresh; failures also stamp the cache.
export function refreshConflictBranches(vaultRoot: string): Promise<void> {
  const key = path.resolve(vaultRoot);
  const inflight = conflictRefreshing.get(key);
  if (inflight) return inflight;
  const last = conflictCheckedAt.get(key);
  if (last !== undefined && Date.now() - last < conflictTtlMs) return Promise.resolve();
  const added = new Set<string>();
  addedDuringRefresh.set(key, added);
  const p = (async () => {
    try {
      const out = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads/conflict/"], vaultRoot);
      st(vaultRoot).conflictBranches = [...new Set([...out.split("\n").filter(Boolean), ...added])];
    } catch {
      /* keep the previous list */
    } finally {
      // A branch added mid-refresh invalidated the cache; keep it invalid.
      conflictCheckedAt.set(key, added.size > 0 ? 0 : Date.now());
      addedDuringRefresh.delete(key);
      conflictRefreshing.delete(key);
    }
  })();
  conflictRefreshing.set(key, p);
  return p;
}

function st(vaultRoot: string): SyncStatus {
  const key = path.resolve(vaultRoot);
  let s = statuses.get(key);
  if (!s) {
    s = {
      unpushed: false,
      lastPushAt: null,
      lastPushOk: null,
      lastPullAt: null,
      lastError: null,
      conflictBranches: [],
    };
    statuses.set(key, s);
  }
  return s;
}

export function getSyncStatus(vaultRoot: string): SyncStatus {
  const s = st(vaultRoot);
  return { ...s, lastError: s.lastError && { ...s.lastError }, conflictBranches: [...s.conflictBranches] };
}

function classify(err: unknown): SyncErrorKind {
  if (err instanceof SyncConflictError) return "conflict";
  const e = err as { name?: string; killed?: boolean };
  if (e.name === "AbortError" || e.killed) return "network";
  const t = errText(err);
  if (
    /could not resolve host|unable to access|failed to connect|couldn't connect|could not read from remote|does not appear to be a git repository|connection (refused|timed out|reset)|unable to connect|timed out|deadline/i.test(
      t,
    )
  ) {
    return "network";
  }
  if (/would be overwritten|local changes|unstaged changes|uncommitted changes|index contains uncommitted/i.test(t)) {
    return "dirty";
  }
  if (/conflict/i.test(t)) return "conflict";
  return "other";
}

function recordError(vaultRoot: string, err: unknown): void {
  st(vaultRoot).lastError = { kind: classify(err), message: errText(err), at: new Date().toISOString() };
}

// ---- git primitives ------------------------------------------------------

// No remote configured is the normal local-dev case, not an error.
export async function hasRemote(vaultRoot: string): Promise<boolean> {
  return (await runGit(["remote"], vaultRoot)).trim().length > 0;
}

// Not upstream-dependent: we always address `origin <branch>` explicitly.
async function currentBranch(vaultRoot: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], vaultRoot)).trim();
}

async function hasUpstream(vaultRoot: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--abbrev-ref", "@{u}"], vaultRoot);
    return true;
  } catch {
    return false;
  }
}

function gitDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".git");
}

function rebaseInProgress(vaultRoot: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((d) => existsSync(path.join(gitDir(vaultRoot), d)));
}

function markerPath(vaultRoot: string): string {
  return path.join(gitDir(vaultRoot), REBASE_MARKER);
}

// Aborts a half-done rebase (if any); never throws.
async function abortRebase(vaultRoot: string): Promise<void> {
  try {
    await runGit(["rebase", "--abort"], vaultRoot);
  } catch {
    /* nothing to abort, or already gone */
  }
}

async function unmergedPaths(vaultRoot: string): Promise<string[]> {
  try {
    return (await runGit(["diff", "--name-only", "--diff-filter=U"], vaultRoot)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Runs under the lock. Only cleans up what the server itself left behind:
// a rebase carrying our marker, and an index.lock old enough to be stale.
// Anything else belongs to a human: fail with "busy" instead of destroying it.
async function selfHeal(vaultRoot: string): Promise<void> {
  const marker = markerPath(vaultRoot);
  if (rebaseInProgress(vaultRoot)) {
    if (!existsSync(marker)) throw new VaultBusyError("vault busy (rebase in progress); try again shortly");
    await abortRebase(vaultRoot);
  }
  // A cherry-pick left by conflict recovery (we died mid re-apply).
  if (cherryPickInProgress(vaultRoot)) {
    if (!existsSync(marker)) throw new VaultBusyError("vault busy (cherry-pick in progress); try again shortly");
    await runGit(["cherry-pick", "--abort"], vaultRoot).catch(() => undefined);
  }
  rmSync(marker, { force: true });

  const lock = path.join(gitDir(vaultRoot), "index.lock");
  let mtimeMs: number;
  try {
    mtimeMs = lstatSync(lock).mtimeMs;
  } catch {
    return;
  }
  if (Date.now() - mtimeMs < STALE_LOCK_MS) {
    throw new VaultBusyError("vault busy (git index is locked); try again shortly");
  }
  rmSync(lock, { force: true });
}

function conflictBranchName(): string {
  return `conflict/${new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "")}`;
}

function cherryPickInProgress(vaultRoot: string): boolean {
  return ["CHERRY_PICK_HEAD", "sequencer"].some((f) => existsSync(path.join(gitDir(vaultRoot), f)));
}

interface LocalCommit {
  sha: string;
  parents: number;
  subject: string;
}

// Resets the working branch to `target`. Never loses uncommitted human changes:
// --keep, else stash around a hard reset.
async function resetKeepingLocalChanges(vaultRoot: string, target: string): Promise<void> {
  try {
    await runGit(["reset", "--keep", target], vaultRoot);
    return;
  } catch {
    /* overlapping local changes: stash around a hard reset */
  }
  let stashed = false;
  try {
    stashed = !/No local changes/.test(
      await runGit(["stash", "push", "--include-untracked", "-m", "second-brain conflict recovery"], vaultRoot),
    );
  } catch {
    /* nothing to stash */
  }
  await runGit(["reset", "--hard", target], vaultRoot);
  if (stashed) {
    try {
      await runGit(["stash", "pop"], vaultRoot);
    } catch {
      await runGit(["reset", "--hard", "HEAD"], vaultRoot).catch(() => undefined);
      console.error("uncommitted changes could not be re-applied after conflict recovery; kept in git stash");
    }
  }
}

// Re-applies the previously unpushed local commits (oldest first) on the freshly
// reset branch. A commit that conflicts is aborted and parked; the others stay.
// On any unexpected failure it falls back to parking everything (branch reset to
// `target` again); if even that reset fails, what was picked so far stays.
async function reapplyLocalCommits(
  vaultRoot: string,
  target: string,
  commits: LocalCommit[],
): Promise<{ parked: Set<string>; conflictPaths: string[] }> {
  const parked = new Set<string>();
  const conflictPaths = new Set<string>();
  const picked: string[] = [];
  try {
    // A merge commit cannot be replayed linearly: keep the old behaviour.
    if (commits.some((c) => c.parents !== 1)) throw new Error("local history contains merge commits");
    for (const c of commits) {
      try {
        // --keep-redundant-commits: a commit the remote already contains still lands
        // (empty) instead of stopping the pick; --allow-empty: same for empty ones.
        await runGit(["cherry-pick", "--allow-empty", "--keep-redundant-commits", c.sha], vaultRoot);
        picked.push(c.sha);
      } catch (err) {
        // Refused before starting (dirty index, overlapping local changes...): unexpected.
        if (!cherryPickInProgress(vaultRoot)) throw err;
        const unmerged = await unmergedPaths(vaultRoot);
        await runGit(["cherry-pick", "--abort"], vaultRoot);
        if (unmerged.length === 0) throw err;
        parked.add(c.sha);
        for (const p of unmerged) conflictPaths.add(p);
      }
    }
  } catch (err) {
    console.error(`conflict recovery: could not re-apply local commits, keeping them all on the backup branch: ${errText(err)}`);
    if (cherryPickInProgress(vaultRoot)) await runGit(["cherry-pick", "--abort"], vaultRoot).catch(() => undefined);
    try {
      await resetKeepingLocalChanges(vaultRoot, target);
      return { parked: new Set(commits.map((c) => c.sha)), conflictPaths: [] };
    } catch (resetErr) {
      console.error(`conflict recovery: reset after failed re-apply failed: ${errText(resetErr)}`);
      return { parked: new Set(commits.filter((c) => !picked.includes(c.sha)).map((c) => c.sha)), conflictPaths: [] };
    }
  }
  return { parked, conflictPaths: [...conflictPaths] };
}

async function changedPaths(vaultRoot: string, sha: string): Promise<string[]> {
  try {
    return (await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], vaultRoot)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Saves the full local state on a backup branch (safety net, pushed best-effort
// so a human sees it), resets the working branch to the remote, then re-applies
// the local commits that still apply cleanly. Only the conflicting ones stay
// parked on the backup branch. Returns null when nothing ended up parked (the
// backup branch is then deleted again).
async function recoverFromRebaseConflict(
  vaultRoot: string,
  branch: string,
  paths: string[],
  origin: SyncConflictOrigin,
): Promise<SyncConflictError | null> {
  let backup = conflictBranchName();
  let local: LocalCommit[] = []; // previously unpushed commits, oldest first
  // False when the local commits could not be listed: nothing is re-applied and
  // the backup branch is kept (it is then the only copy of that work).
  let listed = true;
  try {
    const out = await runGit(["log", "--reverse", "--format=%H%x09%P%x09%s", `origin/${branch}..HEAD`], vaultRoot);
    for (const line of out.split("\n").filter(Boolean)) {
      const [sha, parents = "", ...rest] = line.split("\t");
      local.push({ sha, parents: parents.split(" ").filter(Boolean).length, subject: rest.join("\t") });
    }
  } catch {
    local = [];
    listed = false;
  }
  try {
    await runGit(["branch", backup, "HEAD"], vaultRoot);
  } catch {
    backup = `${backup}-${randomBytes(2).toString("hex")}`;
    await runGit(["branch", backup, "HEAD"], vaultRoot);
  }
  const target = `origin/${branch}`;
  let ok = false;
  let failure: string | undefined;
  // Until the re-apply ran, everything counts as parked (the old, safe behaviour).
  let parkedShas = new Set(local.map((c) => c.sha));
  let conflictPaths = paths;
  const parkedNow = (): LocalCommit[] => local.filter((c) => parkedShas.has(c.sha));
  const keepBackup = (): boolean => !ok || !listed || parkedNow().length > 0;
  try {
    await resetKeepingLocalChanges(vaultRoot, target);
    ok = true;
    if (listed) {
      const r = await reapplyLocalCommits(vaultRoot, target, local);
      parkedShas = r.parked;
      if (r.conflictPaths.length > 0) conflictPaths = r.conflictPaths;
    }
  } catch (err) {
    failure = errText(err);
    throw err;
  } finally {
    const parked = parkedNow();
    const reapplied = local.length - parked.length;
    if (ok) st(vaultRoot).unpushed = reapplied > 0;
    if (keepBackup()) {
      // Backup branch holds parked work: always track it and emit, before any network push.
      addConflictBranch(vaultRoot, backup);
      const details: ParkedCommit[] = [];
      for (const c of parked) details.push({ sha: c.sha, subject: c.subject, paths: await changedPaths(vaultRoot, c.sha) });
      const tokens = new Set<string>();
      for (const c of parked) {
        const m = TOKEN_SUBJECT_RE.exec(c.subject);
        if (m) tokens.add(m[1]);
      }
      emitSyncEvent({
        vaultRoot,
        origin,
        backupBranch: backup,
        ok,
        error: failure,
        commits: parked.map((c) => c.sha).reverse(),
        tokens: [...tokens],
        paths: conflictPaths,
        parked: details,
        reapplied,
      });
    }
  }
  const parked = parkedNow();
  const reapplied = local.length - parked.length;
  if (!keepBackup()) {
    // Every local commit re-applied cleanly: nothing is parked, nothing to report.
    await runGit(["branch", "-D", backup], vaultRoot).catch(() => undefined);
    console.error(`sync: rebase conflicted but all ${reapplied} local commit(s) re-applied cleanly on ${target}`);
    return null;
  }
  const what = listed ? `${parked.length} conflicting local commit(s)` : "the unpushed local commits";
  console.error(
    `SYNC CONFLICT: remote changed ${conflictPaths.join(", ") || "(unknown paths)"}; ${what} parked on branch ${backup}` +
      ` (${parked.map((c) => c.subject).join("; ")}), ${reapplied} re-applied on ${target}`,
  );
  try {
    await runGit(["push", "origin", backup], vaultRoot, NETWORK_TIMEOUT_MS);
  } catch (err) {
    console.error(`could not push backup branch ${backup}: ${errText(err)}`);
  }
  return new SyncConflictError(
    `The remote changed ${conflictPaths.join(", ") || "note(s)"} while unsynced local changes to it were pending: ` +
      `${what} parked on branch ${backup}` +
      `${reapplied > 0 ? `, ${reapplied} other local commit(s) kept` : ""}. This write was not applied; retry it.`,
    backup,
    conflictPaths,
    reapplied,
  );
}

// Autostash re-apply conflicted: the human's changes are safe in the stash
// entry git keeps; clear the conflict markers so the tree is usable again.
async function recoverFromStashConflict(vaultRoot: string, paths: string[]): Promise<SyncConflictError> {
  await runGit(["reset", "--hard", "HEAD"], vaultRoot);
  console.error(`SYNC CONFLICT: uncommitted changes to ${paths.join(", ")} conflict with the remote; kept in git stash`);
  return new SyncConflictError(
    `Uncommitted changes in the vault (${paths.join(", ")}) conflict with remote changes; they were kept in git stash. This write was not applied; retry it.`,
    null,
    paths,
  );
}

// Pulls origin/<branch> with rebase + autostash. Conflicts are recovered (see
// above) and thrown as SyncConflictError; other failures (network down) are
// thrown as plain errors with the repo untouched. No-op without a remote.
export async function pullRebase(
  vaultRoot: string,
  signal?: AbortSignal,
  origin: SyncConflictOrigin = "write",
): Promise<void> {
  if (!(await hasRemote(vaultRoot))) return;
  const branch = await currentBranch(vaultRoot);
  writeFileSync(markerPath(vaultRoot), String(process.pid));
  try {
    try {
      await runGit(["pull", "--rebase", "--autostash", "origin", branch], vaultRoot, NETWORK_TIMEOUT_MS, signal);
      st(vaultRoot).lastPullAt = new Date().toISOString();
    } catch (err) {
      // A brand-new remote has no such branch yet: nothing to pull.
      if (/couldn't find remote ref/i.test(errText(err))) return;
      if (rebaseInProgress(vaultRoot)) {
        const paths = await unmergedPaths(vaultRoot);
        await abortRebase(vaultRoot); // also restores the autostash
        if (paths.length > 0) {
          const e = await recoverFromRebaseConflict(vaultRoot, branch, paths, origin);
          if (e) {
            recordError(vaultRoot, e);
            throw e;
          }
          // Everything re-applied cleanly on the remote: a successful pull after all.
          st(vaultRoot).lastPullAt = new Date().toISOString();
          return;
        }
      }
      throw err;
    }
    const left = await unmergedPaths(vaultRoot);
    if (left.length > 0) {
      const e = await recoverFromStashConflict(vaultRoot, left);
      recordError(vaultRoot, e);
      throw e;
    }
  } finally {
    rmSync(markerPath(vaultRoot), { force: true });
  }
}

// Write-then-rename so a crash mid-write never leaves a half-written note.
// The temp name is random and opened O_EXCL|O_NOFOLLOW so a planted symlink
// can't redirect the write.
export function writeNoteAtomic(vaultRoot: string, absolutePath: string, content: string | Buffer): void {
  assertSafePath(vaultRoot, absolutePath);
  const dir = path.dirname(absolutePath);
  mkdirSync(dir, { recursive: true });
  // mkdir may have followed a symlink planted in between.
  assertSafePath(vaultRoot, dir);

  const tmpPath = `${absolutePath}.tmp-${randomBytes(8).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    );
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, absolutePath);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

// Returns the new commit's sha, or null when nothing was staged for the path
// (identical re-write): no commit is made, and HEAD (possibly someone else's
// commit) is deliberately not reported as ours.
export async function commitFile(
  vaultRoot: string,
  relativePath: string,
  message: string,
): Promise<string | null> {
  await runGit(["add", "--", relativePath], vaultRoot);
  let staged = true;
  try {
    // Exit 0 = nothing staged for this path (identical re-write): skip the commit.
    await runGit(["diff", "--cached", "--quiet", "--", relativePath], vaultRoot);
    staged = false;
  } catch (err) {
    if ((err as { code?: unknown }).code !== 1) throw err;
  }
  if (!staged) return null;
  // Pathspec: never sweep in other staged changes (e.g. a human's drafts).
  await runGit(["commit", "-m", message, "--", relativePath], vaultRoot);
  return (await runGit(["rev-parse", "HEAD"], vaultRoot)).trim();
}

// ---- push ----------------------------------------------------------------

// Shutdown aborts pending pushes: they are network-only and the next periodic
// sync retries them. Stays aborted until resetPushAbort() (tests only).
let pushAbort = new AbortController();

export function abortPendingPushes(): void {
  pushAbort.abort();
}

export function resetPushAbort(): void {
  pushAbort = new AbortController();
}

async function pushOnce(vaultRoot: string, signal: AbortSignal): Promise<void> {
  const branch = await currentBranch(vaultRoot);
  await runGit(["push", "origin", branch], vaultRoot, NETWORK_TIMEOUT_MS, signal);
}

// Never rejects. Retries pull first (a rejected push is usually non-fast-forward).
// Bounded by one overall deadline; every child is killed when it expires, so
// by the time this settles no git process of ours is left running.
async function pushWithRetry(vaultRoot: string): Promise<void> {
  const s = st(vaultRoot);
  const signal = AbortSignal.any([AbortSignal.timeout(pushDeadlineMs()), pushAbort.signal]);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PUSH_RETRIES && !signal.aborted; attempt++) {
    try {
      if (attempt > 1) {
        try {
          await pullRebase(vaultRoot, signal, "push-retry");
        } catch (pullErr) {
          lastErr = pullErr;
          if (pullErr instanceof SyncConflictError) break; // retrying can't help
        }
      }
      await pushOnce(vaultRoot, signal);
      s.unpushed = false;
      s.lastPushOk = true;
      s.lastPushAt = new Date().toISOString();
      s.lastError = null;
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < PUSH_RETRIES) await sleep(PUSH_BACKOFF_MS * attempt, signal);
    }
  }
  if (signal.aborted && !lastErr) lastErr = new Error(pushAbort.signal.aborted ? "push aborted (shutdown)" : "push deadline exceeded");
  s.lastPushOk = false;
  s.lastPushAt = new Date().toISOString();
  recordError(vaultRoot, lastErr);
  console.error(`git push failed: ${s.lastError?.message}`);
}

// ---- lock ----------------------------------------------------------------

// Single in-process mutex so concurrent calls serialize instead of interleaving
// git operations on the same working tree.
//
// The queue only advances once the *push* from the previous turn has settled.
// That is safe because pushWithRetry has a hard overall deadline and kills its
// children, so it always settles in bounded time.
interface LockedResult<T> {
  value: T;
  // Resolves when background work (the push) kicked off by this turn settles.
  settle: Promise<unknown>;
}

let queue: Promise<unknown> = Promise.resolve();

function opMarkerPath(vaultRoot: string): string {
  return path.join(gitDir(vaultRoot), OP_MARKER);
}

// Best effort: a failing marker must never fail the operation itself.
function setOpMarker(vaultRoot: string): void {
  try {
    writeFileSync(opMarkerPath(vaultRoot), String(process.pid));
  } catch {
    /* no .git yet */
  }
}

function clearOpMarker(vaultRoot: string): void {
  rmSync(opMarkerPath(vaultRoot), { force: true });
}

// The op marker covers the whole turn, including the background push.
function withLock<T>(vaultRoot: string, fn: () => Promise<LockedResult<T>>): Promise<T> {
  const scheduled = queue.then(async () => {
    setOpMarker(vaultRoot);
    try {
      return await fn();
    } catch (err) {
      clearOpMarker(vaultRoot);
      throw err;
    }
  });
  queue = scheduled.then(
    async (r) => {
      try {
        await r.settle.catch(() => undefined);
      } finally {
        clearOpMarker(vaultRoot);
      }
    },
    () => undefined,
  );
  return scheduled.then((r) => r.value);
}

// Resolves once the lock queue is idle (including in-flight pushes).
export async function drainWrites(): Promise<void> {
  let q: Promise<unknown>;
  do {
    q = queue;
    await q;
  } while (q !== queue);
}

// A create-only write found the note already there.
export class NoteExistsError extends Error {
  constructor() {
    super("note already exists");
    this.name = "NoteExistsError";
  }
}

export interface WriteOptions {
  // Create-only: refuse if the path exists (any type), checked inside the lock
  // after the pull and the path-safety check.
  mustNotExist?: boolean;
  // Runs inside the lock after the pull; throwing aborts the write (e.g. inbox quota).
  precheck?: () => void | Promise<void>;
}

export function syncWrite(
  vaultRoot: string,
  absolutePath: string,
  content: string,
  commitMessage: string,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  return lockedWrite(vaultRoot, absolutePath, () => content, commitMessage, opts);
}

export class NoteTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteTooLargeError";
  }
}

// The existing note is not valid UTF-8: appending would have to decode it and
// would corrupt the invalid bytes (U+FFFD). Such a note must be edited in git.
export class NoteNotUtf8Error extends Error {
  constructor() {
    super("note is not valid UTF-8");
    this.name = "NoteNotUtf8Error";
  }
}

// commitSha is null when the content was identical and nothing was committed.
// It is "" in the rare case where the commit landed but its sha could not be read back.
export interface WriteResult {
  commitSha: string | null;
}

// Read-modify-write inside the write lock, so concurrent appends never lose
// updates. Missing file counts as empty. Exactly one newline joins old and new.
// `text` may be a function: it runs inside the lock, so anything time-dependent
// (journal timestamps) is ordered like the file. maxChars caps the resulting note.
export function syncAppend(
  vaultRoot: string,
  absolutePath: string,
  text: string | (() => string),
  commitMessage: string,
  maxChars?: number,
  // Validates the resulting content inside the lock; throws to refuse.
  check?: (next: string) => void,
): Promise<WriteResult> {
  return lockedWrite(
    vaultRoot,
    absolutePath,
    (raw) => {
      const prev = raw ? raw.toString("utf8") : "";
      if (raw && !Buffer.from(prev, "utf8").equals(raw)) throw new NoteNotUtf8Error();
      const t = typeof text === "function" ? text() : text;
      const next = (prev === "" || prev.endsWith("\n") ? prev : prev + "\n") + t.replace(/\n+$/, "") + "\n";
      if (maxChars !== undefined && next.length > maxChars) throw new NoteTooLargeError("note would exceed the size limit");
      check?.(next);
      return next;
    },
    commitMessage,
  );
}

// The source note has local changes that are not committed (a human is editing it).
export class MoveSourceDirtyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveSourceDirtyError";
  }
}

export class MoveSourceMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveSourceMissingError";
  }
}

export class MoveTargetExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveTargetExistsError";
  }
}

// Pull (best effort) under the lock; shared by every write operation.
async function prepareLocked(vaultRoot: string): Promise<boolean> {
  await selfHeal(vaultRoot);
  const remote = await hasRemote(vaultRoot);
  if (remote) {
    try {
      await pullRebase(vaultRoot);
    } catch (err) {
      if (err instanceof SyncConflictError) throw err;
      // Remote unreachable: still commit locally; the push retry catches up.
      recordError(vaultRoot, err);
      console.error(`git pull failed, writing locally: ${errText(err)}`);
    }
  }
  return remote;
}

// Resolve the caller now; the lock queue (settle) waits on the push instead.
function finishLocked<T>(vaultRoot: string, remote: boolean, value: T): LockedResult<T> {
  let settle: Promise<unknown> = Promise.resolve();
  if (remote) {
    st(vaultRoot).unpushed = true;
    settle = pushWithRetry(vaultRoot);
  }
  return { value, settle };
}

async function headOrEmpty(vaultRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], vaultRoot).catch(() => "")).trim();
}

function lockedWrite(
  vaultRoot: string,
  absolutePath: string,
  // Gets the note's current raw bytes (null when missing); throws to refuse.
  build: (previous: Buffer | null) => string,
  commitMessage: string,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  return withLock(vaultRoot, async () => {
    assertSafePath(vaultRoot, absolutePath);
    const remote = await prepareLocked(vaultRoot);
    if (opts.mustNotExist && lstatOrNull(absolutePath)) throw new NoteExistsError();
    await opts.precheck?.();

    const relativePath = path.relative(vaultRoot, absolutePath);
    const previous = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
    // Built and validated before anything is touched: a refusal leaves the file
    // (mtime) and the index (a human's staged state) exactly as they were.
    const next = build(previous);
    const headBefore = await headOrEmpty(vaultRoot);
    let commitSha: string | null;
    try {
      writeNoteAtomic(vaultRoot, absolutePath, next);
      commitSha = await commitFile(vaultRoot, relativePath, commitMessage);
    } catch (err) {
      // Roll back only if the commit did not land (git may report an error after
      // it did, e.g. a failing post-commit hook or a timeout): otherwise the working
      // tree would disagree with HEAD and the next append would silently revert this write.
      const headNow = await headOrEmpty(vaultRoot);
      if (headNow !== headBefore) {
        console.error(`git write: error after commit landed, keeping it: ${errText(err)}`);
        return finishLocked(vaultRoot, remote, { commitSha: headNow });
      }
      await restoreNote(vaultRoot, absolutePath, relativePath, previous);
      throw err;
    }
    return finishLocked(vaultRoot, remote, { commitSha });
  });
}

// Moves a note inside the lock; refuses to overwrite. Both paths are committed
// via pathspec so unrelated staged changes are never swept in.
export function syncMove(
  vaultRoot: string,
  fromAbs: string,
  toAbs: string,
  commitMessage: string,
): Promise<{ commitSha: string; to: string }> {
  return withLock(vaultRoot, async () => {
    assertSafePath(vaultRoot, fromAbs);
    assertSafePath(vaultRoot, toAbs);
    const remote = await prepareLocked(vaultRoot);

    if (!existsSync(fromAbs)) throw new MoveSourceMissingError(`source not found: ${fromAbs}`);
    if (lstatOrNull(toAbs)) throw new MoveTargetExistsError(`target exists: ${toAbs}`);

    const fromRel = path.relative(vaultRoot, fromAbs);
    const toRel = path.relative(vaultRoot, toAbs);
    const inHead = (await runGit(["ls-tree", "--name-only", "HEAD", "--", fromRel], vaultRoot).catch(() => "")).trim() !== "";
    // A committed note with uncommitted edits: moving it would sweep a human's work into our commit.
    if (inHead && (await runGit(["status", "--porcelain", "--", fromRel], vaultRoot)).trim() !== "") {
      throw new MoveSourceDirtyError(`source has uncommitted changes: ${fromRel}`);
    }
    const headBefore = (await runGit(["rev-parse", "HEAD"], vaultRoot).catch(() => "")).trim();
    let commitSha = "";
    try {
      mkdirSync(path.dirname(toAbs), { recursive: true });
      assertSafePath(vaultRoot, path.dirname(toAbs));
      const tracked = (await runGit(["ls-files", "--", fromRel], vaultRoot)).trim() !== "";
      if (tracked) {
        await runGit(["mv", "--", fromRel, toRel], vaultRoot);
      } else {
        // Untracked source: plain rename, stage only the target.
        renameSync(fromAbs, toAbs);
        await runGit(["add", "--", toRel], vaultRoot);
      }
      // Pathspec from what HEAD really has: a source that was only staged is not in HEAD.
      const specs = inHead ? [fromRel, toRel] : [toRel];
      await runGit(["commit", "-m", commitMessage, "--", ...specs], vaultRoot);
    } catch (err) {
      // Roll back only if the commit did not land (git may report an error after it did).
      const headNow = (await runGit(["rev-parse", "HEAD"], vaultRoot).catch(() => "")).trim();
      if (headNow !== headBefore) {
        console.error(`git move: error after commit landed, keeping the move: ${errText(err)}`);
      } else {
        try {
          if (!existsSync(fromAbs) && existsSync(toAbs)) renameSync(toAbs, fromAbs);
        } catch {
          /* best effort */
        }
        await runGit(["reset", "-q", "--", fromRel, toRel], vaultRoot).catch(() => undefined);
        throw err;
      }
    }
    try {
      commitSha = (await runGit(["rev-parse", "HEAD"], vaultRoot)).trim();
    } catch (err) {
      // The commit is in; never undo the move over a failed read-back.
      console.error(`git move: rev-parse after commit failed: ${errText(err)}`);
    }
    return finishLocked(vaultRoot, remote, { commitSha, to: toAbs });
  });
}

// Leave the tree clean for the next call after a failed write/commit.
async function restoreNote(
  vaultRoot: string,
  absolutePath: string,
  relativePath: string,
  previous: Buffer | null,
): Promise<void> {
  try {
    if (previous === null) {
      if (existsSync(absolutePath) || lstatOrNull(absolutePath)) unlinkSync(absolutePath);
    } else {
      // Raw bytes: a note that is not valid UTF-8 must come back byte for byte.
      writeNoteAtomic(vaultRoot, absolutePath, previous);
    }
  } catch {
    /* best effort */
  }
  try {
    await runGit(["rm", "--cached", "-q", "--ignore-unmatch", "--", relativePath], vaultRoot);
  } catch {
    /* best effort */
  }
  // A restored file that is tracked must be re-synced to HEAD's index entry.
  try {
    await runGit(["reset", "-q", "--", relativePath], vaultRoot);
  } catch {
    /* no HEAD yet */
  }
}

function lstatOrNull(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---- periodic sync -------------------------------------------------------

// Pulls remote changes and pushes leftover local commits under the same lock
// as writes. Errors are logged, never thrown.
export function startPeriodicSync(vaultRoot: string, intervalMs: number): () => void {
  let running = false;
  const idle = { value: undefined, settle: Promise.resolve() };
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await withLock(vaultRoot, async () => {
        await selfHeal(vaultRoot);
        if (!(await hasRemote(vaultRoot))) return idle;
        try {
          await pullRebase(vaultRoot, undefined, "periodic");
        } catch (err) {
          recordError(vaultRoot, err);
          console.error(`periodic sync pull failed: ${errText(err)}`);
          return idle;
        }
        const s = st(vaultRoot);
        if (!s.unpushed && !(await hasLocalOnlyCommits(vaultRoot))) return idle;
        s.unpushed = true;
        return { value: undefined, settle: pushWithRetry(vaultRoot) };
      });
    } catch (err) {
      console.error(`periodic sync failed: ${errText(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function hasLocalOnlyCommits(vaultRoot: string): Promise<boolean> {
  try {
    const branch = await currentBranch(vaultRoot);
    try {
      await runGit(["rev-parse", "--verify", "-q", `origin/${branch}`], vaultRoot);
    } catch {
      // Remote has no such branch yet: everything we have is unpushed.
      await runGit(["rev-parse", "--verify", "-q", "HEAD"], vaultRoot);
      return true;
    }
    return parseInt(await runGit(["rev-list", "--count", `origin/${branch}..HEAD`], vaultRoot), 10) > 0;
  } catch {
    return false;
  }
}

// ---- bootstrap -----------------------------------------------------------

export async function ensureVaultRepo(
  vaultRoot: string,
  opts: { remoteUrl?: string; branch?: string; shouldAbort?: () => boolean },
): Promise<void> {
  // Checked between git steps so a signal during startup stops it promptly
  // (each step is itself bounded by its timeout).
  const check = (): void => {
    if (opts.shouldAbort?.()) throw new BootstrapAbortedError();
  };
  check();
  const branch = opts.branch ?? "main";
  const { remoteUrl } = opts;
  mkdirSync(vaultRoot, { recursive: true });

  if (!existsSync(path.join(vaultRoot, ".git"))) {
    if (readdirSync(vaultRoot).length > 0) {
      throw new Error(`${vaultRoot} is not a git repository and is not empty; refusing to initialize`);
    }
    if (remoteUrl) {
      try {
        await runGit(["clone", "-c", "core.symlinks=false", "--branch", branch, remoteUrl, "."], vaultRoot, NETWORK_TIMEOUT_MS * 4);
      } catch (err) {
        // A brand-new empty remote has no branch to clone: start locally instead.
        let emptyRemote = false;
        try {
          emptyRemote = !(await runGit(["ls-remote", "--heads", remoteUrl], vaultRoot, NETWORK_TIMEOUT_MS)).trim();
        } catch {
          /* unreachable: report the clone error */
        }
        if (!emptyRemote) throw new Error(`git clone failed: ${errText(err)}`);
        rmSync(path.join(vaultRoot, ".git"), { recursive: true, force: true });
        await runGit(["init", "-b", branch], vaultRoot);
        await runGit(["remote", "add", "origin", remoteUrl], vaultRoot);
      }
    } else {
      await runGit(["init", "-b", branch], vaultRoot);
      console.warn("vault has no git remote: writes will not be replicated");
    }
  }

  check();
  // A leftover op marker means the previous server died mid-operation, so an
  // index.lock is ours. A lock without the marker is foreign: left alone.
  const opMarker = opMarkerPath(vaultRoot);
  if (existsSync(opMarker)) {
    const lock = path.join(gitDir(vaultRoot), "index.lock");
    const hadLock = existsSync(lock);
    rmSync(lock, { force: true });
    rmSync(opMarker, { force: true });
    console.warn(
      `previous run died mid-operation${hadLock ? ": removed leftover .git/index.lock" : ""}`,
    );
  }

  await runGit(["config", "core.symlinks", "false"], vaultRoot);
  check();

  let origin: string | null = null;
  try {
    origin = (await runGit(["remote", "get-url", "origin"], vaultRoot)).trim();
  } catch {
    /* no origin */
  }
  if (remoteUrl) {
    if (origin === null) await runGit(["remote", "add", "origin", remoteUrl], vaultRoot);
    else if (origin !== remoteUrl) {
      throw new Error(`existing origin remote points elsewhere (${redact(origin)}); expected ${redact(remoteUrl)}`);
    }
  }
  if (origin === null && !remoteUrl) return;

  check();
  const current = (await runGit(["symbolic-ref", "--short", "HEAD"], vaultRoot)).trim();
  if (current !== branch) {
    throw new Error(`vault is on branch "${current}" but "${branch}" was requested`);
  }
  check();
  if (!(await hasUpstream(vaultRoot))) {
    try {
      await runGit(["fetch", "origin"], vaultRoot, NETWORK_TIMEOUT_MS);
    } catch (err) {
      console.error(`startup fetch failed: ${errText(err)}`);
      return;
    }
    try {
      await runGit(["rev-parse", "--verify", `origin/${branch}`], vaultRoot);
      await runGit(["branch", `--set-upstream-to=origin/${branch}`], vaultRoot);
    } catch {
      /* remote has no such branch yet; first push sets upstream */
    }
  }
}

// ---- inbox review (accept / reject) ---------------------------------------

// The proposal file vanished before the locked step (already accepted/rejected).
export class InboxMissingError extends Error {
  constructor() {
    super("inbox proposal not found");
    this.name = "InboxMissingError";
  }
}

// The proposal cannot be accepted as it stands (malformed, invalid target/content, too large).
export class InboxInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxInvalidError";
  }
}

// What to do with a proposal: always remove it; on accept also write `content` to targetAbs.
export interface InboxResolution {
  message: string;
  accept?: {
    targetAbs: string;
    content: string;
    // Default false: refuse when the target exists.
    overwrite?: boolean;
  };
}

// Removes an inbox proposal and, on accept, writes its content to the target, in ONE
// commit under the write lock. `decide` runs INSIDE the lock, after the pull, on the
// bytes that are about to be committed, so what it validates is exactly what lands.
// It may throw (InboxInvalidError, NoteRuleError, ...) to abort before any change.
// commitSha is null when nothing needed committing (untracked proposal, identical target).
export function syncInboxResolve(
  vaultRoot: string,
  inboxAbs: string,
  decide: (raw: Buffer) => InboxResolution | Promise<InboxResolution>,
): Promise<{ commitSha: string | null }> {
  return withLock(vaultRoot, async () => {
    assertSafePath(vaultRoot, inboxAbs);
    const remote = await prepareLocked(vaultRoot);

    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(inboxAbs);
    } catch {
      throw new InboxMissingError();
    }
    if (!st.isFile()) throw new InboxInvalidError("proposal is not a regular file");
    const inboxPrev = readFileSync(inboxAbs);
    const { message, accept } = await decide(inboxPrev);
    if (accept) {
      assertSafePath(vaultRoot, accept.targetAbs);
      if (!accept.overwrite && lstatOrNull(accept.targetAbs)) throw new NoteExistsError();
    }

    const inboxRel = path.relative(vaultRoot, inboxAbs);
    const targetRel = accept ? path.relative(vaultRoot, accept.targetAbs) : undefined;
    const targetPrev = accept && existsSync(accept.targetAbs) ? readFileSync(accept.targetAbs) : null;
    const inHead = (await runGit(["ls-tree", "--name-only", "HEAD", "--", inboxRel], vaultRoot).catch(() => "")).trim() !== "";
    const headBefore = (await runGit(["rev-parse", "HEAD"], vaultRoot).catch(() => "")).trim();

    let commitSha: string | null = null;
    try {
      if (accept && targetRel) {
        writeNoteAtomic(vaultRoot, accept.targetAbs, accept.content);
        await runGit(["add", "--", targetRel], vaultRoot);
      }
      unlinkSync(inboxAbs);
      await runGit(["rm", "-q", "--cached", "--ignore-unmatch", "--", inboxRel], vaultRoot);
      const specs = [...(targetRel ? [targetRel] : []), ...(inHead ? [inboxRel] : [])];
      if (specs.length > 0) {
        let staged = true;
        try {
          // Exit 0 = nothing staged (identical overwrite): skip the commit, like commitFile.
          await runGit(["diff", "--cached", "--quiet", "--", ...specs], vaultRoot);
          staged = false;
        } catch (err) {
          if ((err as { code?: unknown }).code !== 1) throw err;
        }
        if (staged) {
          await runGit(["commit", "-m", message, "--", ...specs], vaultRoot);
          commitSha = (await runGit(["rev-parse", "HEAD"], vaultRoot)).trim();
        }
      }
    } catch (err) {
      const headNow = (await runGit(["rev-parse", "HEAD"], vaultRoot).catch(() => "")).trim();
      if (headNow !== headBefore) {
        console.error(`inbox resolve: error after commit landed, keeping it: ${errText(err)}`);
        return finishLocked(vaultRoot, remote, { commitSha: headNow });
      }
      await restoreNote(vaultRoot, inboxAbs, inboxRel, inboxPrev);
      if (accept && targetRel) await restoreNote(vaultRoot, accept.targetAbs, targetRel, targetPrev);
      throw err;
    }
    return finishLocked(vaultRoot, remote, { commitSha });
  });
}

export interface NoteHistoryEntry {
  sha: string;
  /** Full 40-hex commit hash. */
  hash: string;
  /** Vault-relative path of the note AT this commit (differs from the current one after renames). */
  path: string;
  date: string;
  author: string;
  subject: string;
}

// Read-only: git log of one note, following renames. No vault lock needed.
// `path` is the vault-relative path (forward slashes) git was asked about.
// `canRead` gets the note's vault-relative path AT each commit (newest to oldest); history
// stops at the first path it refuses, so renames never leak history from unreadable places.
export async function noteHistory(
  vaultRoot: string,
  absolutePath: string,
  limit: number,
  canRead: (relPath: string) => boolean = () => true,
): Promise<{ path: string; entries: NoteHistoryEntry[]; restricted: boolean }> {
  assertSafePath(vaultRoot, absolutePath);
  const rel = path.relative(path.resolve(vaultRoot), path.resolve(absolutePath)).split(path.sep).join("/");
  try {
    await runGit(["rev-parse", "--verify", "-q", "HEAD"], vaultRoot);
  } catch (err) {
    // Fresh repo without any commit (exit 1, quiet): no history, not a failure.
    if ((err as { code?: unknown }).code === 1) return { path: rel, entries: [], restricted: false };
    throw err;
  }
  // Per commit: a header line starting with \x01, then "M\tpath" or "R100\told\tnew" for the
  // followed file. A path git had to quote is not a valid slug path, so canRead refuses it.
  const out = await runGit(
    ["log", "--follow", "--name-status", "--format=%x01%h%x09%H%x09%aI%x09%an%x09%s", "--", rel],
    vaultRoot,
  );
  const entries: NoteHistoryEntry[] = [];
  let restricted = false;
  let current = rel; // path at the commit being walked (newest to oldest)
  for (const block of out.split("\x01").slice(1)) {
    const [header, ...statusLines] = block.split("\n");
    const status = statusLines.find((l) => l.includes("\t"));
    const parts = status?.split("\t");
    const atCommit = parts ? parts[parts.length - 1] : current;
    // After a rename/copy line, older commits know the file by its old path.
    if (parts && /^[RC]/.test(parts[0]) && parts.length >= 3) current = parts[1];
    if (!canRead(atCommit)) {
      restricted = true;
      break;
    }
    const [sha, hash, date, author, ...rest] = header.split("\t");
    entries.push({ sha, hash, path: atCommit, date, author, subject: rest.join("\t") });
    if (entries.length >= limit) break;
  }
  return { path: rel, entries, restricted };
}
