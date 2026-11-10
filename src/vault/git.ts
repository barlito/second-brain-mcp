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

function pushDeadlineMs(): number {
  return Number(process.env.SB_PUSH_DEADLINE_MS) || DEFAULT_PUSH_DEADLINE_MS;
}

// LANG/LC_ALL=C: error-message matching must not depend on the locale.
// GIT_TERMINAL_PROMPT=0: never block waiting for credentials on a tty.
const GIT_ENV = { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

function git(
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

function redact(text: string): string {
  return text.replace(/:\/\/[^@/\s]+@/g, "://***@");
}

function errText(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return redact(`${e.message ?? String(err)} ${e.stderr ?? ""}`.trim());
}

// ---- errors --------------------------------------------------------------

// The remote changed the same notes as local unpushed work. The local work was
// moved to a backup branch and the working branch reset to the remote.
export class SyncConflictError extends Error {
  constructor(
    message: string,
    readonly backupBranch: string | null,
    readonly paths: string[],
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
  return (await git(["remote"], vaultRoot)).trim().length > 0;
}

// Not upstream-dependent: we always address `origin <branch>` explicitly.
async function currentBranch(vaultRoot: string): Promise<string> {
  return (await git(["symbolic-ref", "--short", "HEAD"], vaultRoot)).trim();
}

async function hasUpstream(vaultRoot: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--abbrev-ref", "@{u}"], vaultRoot);
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
    await git(["rebase", "--abort"], vaultRoot);
  } catch {
    /* nothing to abort, or already gone */
  }
}

async function unmergedPaths(vaultRoot: string): Promise<string[]> {
  try {
    return (await git(["diff", "--name-only", "--diff-filter=U"], vaultRoot)).split("\n").filter(Boolean);
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

// Saves local unpushed commits on a backup branch (pushed best-effort so a
// human sees it), then resets the working branch to the remote. Never loses
// uncommitted human changes: --keep, else stash around a hard reset.
async function recoverFromRebaseConflict(
  vaultRoot: string,
  branch: string,
  paths: string[],
): Promise<SyncConflictError> {
  let backup = conflictBranchName();
  try {
    await git(["branch", backup, "HEAD"], vaultRoot);
  } catch {
    backup = `${backup}-${randomBytes(2).toString("hex")}`;
    await git(["branch", backup, "HEAD"], vaultRoot);
  }
  const target = `origin/${branch}`;
  try {
    await git(["reset", "--keep", target], vaultRoot);
  } catch {
    let stashed = false;
    try {
      stashed = !/No local changes/.test(
        await git(["stash", "push", "--include-untracked", "-m", "second-brain conflict recovery"], vaultRoot),
      );
    } catch {
      /* nothing to stash */
    }
    await git(["reset", "--hard", target], vaultRoot);
    if (stashed) {
      try {
        await git(["stash", "pop"], vaultRoot);
      } catch {
        await git(["reset", "--hard", "HEAD"], vaultRoot).catch(() => undefined);
        console.error("uncommitted changes could not be re-applied after conflict recovery; kept in git stash");
      }
    }
  }
  const s = st(vaultRoot);
  s.conflictBranches.push(backup);
  s.unpushed = false;
  console.error(
    `SYNC CONFLICT: remote changed ${paths.join(", ") || "(unknown paths)"}; local commits saved on branch ${backup}, ${branch} reset to ${target}`,
  );
  try {
    await git(["push", "origin", backup], vaultRoot, NETWORK_TIMEOUT_MS);
  } catch (err) {
    console.error(`could not push backup branch ${backup}: ${errText(err)}`);
  }
  return new SyncConflictError(
    `The remote changed the same note(s) as unsynced changes (${paths.join(", ")}). Your version was saved to branch ${backup}; retry the write.`,
    backup,
    paths,
  );
}

// Autostash re-apply conflicted: the human's changes are safe in the stash
// entry git keeps; clear the conflict markers so the tree is usable again.
async function recoverFromStashConflict(vaultRoot: string, paths: string[]): Promise<SyncConflictError> {
  await git(["reset", "--hard", "HEAD"], vaultRoot);
  console.error(`SYNC CONFLICT: uncommitted changes to ${paths.join(", ")} conflict with the remote; kept in git stash`);
  return new SyncConflictError(
    `Uncommitted changes in the vault conflict with remote changes (${paths.join(", ")}); they were kept in git stash. Retry the write.`,
    null,
    paths,
  );
}

// Pulls origin/<branch> with rebase + autostash. Conflicts are recovered (see
// above) and thrown as SyncConflictError; other failures (network down) are
// thrown as plain errors with the repo untouched. No-op without a remote.
export async function pullRebase(vaultRoot: string, signal?: AbortSignal): Promise<void> {
  if (!(await hasRemote(vaultRoot))) return;
  const branch = await currentBranch(vaultRoot);
  writeFileSync(markerPath(vaultRoot), String(process.pid));
  try {
    try {
      await git(["pull", "--rebase", "--autostash", "origin", branch], vaultRoot, NETWORK_TIMEOUT_MS, signal);
      st(vaultRoot).lastPullAt = new Date().toISOString();
    } catch (err) {
      // A brand-new remote has no such branch yet: nothing to pull.
      if (/couldn't find remote ref/i.test(errText(err))) return;
      if (rebaseInProgress(vaultRoot)) {
        const paths = await unmergedPaths(vaultRoot);
        await abortRebase(vaultRoot); // also restores the autostash
        if (paths.length > 0) {
          const e = await recoverFromRebaseConflict(vaultRoot, branch, paths);
          recordError(vaultRoot, e);
          throw e;
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
export function writeNoteAtomic(vaultRoot: string, absolutePath: string, content: string): void {
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
    writeSync(fd, content);
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

export async function commitFile(
  vaultRoot: string,
  relativePath: string,
  message: string,
): Promise<string> {
  await git(["add", "--", relativePath], vaultRoot);
  let staged = true;
  try {
    // Exit 0 = nothing staged for this path (identical re-write): skip the commit.
    await git(["diff", "--cached", "--quiet", "--", relativePath], vaultRoot);
    staged = false;
  } catch (err) {
    if ((err as { code?: unknown }).code !== 1) throw err;
  }
  if (staged) {
    // Pathspec: never sweep in other staged changes (e.g. a human's drafts).
    await git(["commit", "-m", message, "--", relativePath], vaultRoot);
  }
  return (await git(["rev-parse", "HEAD"], vaultRoot)).trim();
}

// ---- push ----------------------------------------------------------------

async function pushOnce(vaultRoot: string, signal: AbortSignal): Promise<void> {
  const branch = await currentBranch(vaultRoot);
  await git(["push", "origin", branch], vaultRoot, NETWORK_TIMEOUT_MS, signal);
}

// Never rejects. Retries pull first (a rejected push is usually non-fast-forward).
// Bounded by one overall deadline; every child is killed when it expires, so
// by the time this settles no git process of ours is left running.
async function pushWithRetry(vaultRoot: string): Promise<void> {
  const s = st(vaultRoot);
  const signal = AbortSignal.timeout(pushDeadlineMs());
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PUSH_RETRIES && !signal.aborted; attempt++) {
    try {
      if (attempt > 1) {
        try {
          await pullRebase(vaultRoot, signal);
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
  if (signal.aborted && !lastErr) lastErr = new Error("push deadline exceeded");
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

function withLock<T>(fn: () => Promise<LockedResult<T>>): Promise<T> {
  const scheduled = queue.then(fn);
  queue = scheduled.then(
    async (r) => {
      await r.settle.catch(() => undefined);
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

export function syncWrite(
  vaultRoot: string,
  absolutePath: string,
  content: string,
  commitMessage: string,
): Promise<{ commitSha: string }> {
  return withLock(async () => {
    assertSafePath(vaultRoot, absolutePath);
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

    const relativePath = path.relative(vaultRoot, absolutePath);
    const previous = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
    let commitSha: string;
    try {
      writeNoteAtomic(vaultRoot, absolutePath, content);
      commitSha = await commitFile(vaultRoot, relativePath, commitMessage);
    } catch (err) {
      await restoreNote(vaultRoot, absolutePath, relativePath, previous);
      throw err;
    }

    // Resolve the caller with the commit now — don't make them wait on network
    // push latency. The lock queue (settle) waits on it instead.
    let settle: Promise<unknown> = Promise.resolve();
    if (remote) {
      st(vaultRoot).unpushed = true;
      settle = pushWithRetry(vaultRoot);
    }
    return { value: { commitSha }, settle };
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
      writeNoteAtomic(vaultRoot, absolutePath, previous.toString("utf8"));
    }
  } catch {
    /* best effort */
  }
  try {
    await git(["rm", "--cached", "-q", "--ignore-unmatch", "--", relativePath], vaultRoot);
  } catch {
    /* best effort */
  }
  // A restored file that is tracked must be re-synced to HEAD's index entry.
  try {
    await git(["reset", "-q", "--", relativePath], vaultRoot);
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
      await withLock(async () => {
        await selfHeal(vaultRoot);
        if (!(await hasRemote(vaultRoot))) return idle;
        try {
          await pullRebase(vaultRoot);
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
      await git(["rev-parse", "--verify", "-q", `origin/${branch}`], vaultRoot);
    } catch {
      // Remote has no such branch yet: everything we have is unpushed.
      await git(["rev-parse", "--verify", "-q", "HEAD"], vaultRoot);
      return true;
    }
    return parseInt(await git(["rev-list", "--count", `origin/${branch}..HEAD`], vaultRoot), 10) > 0;
  } catch {
    return false;
  }
}

// ---- bootstrap -----------------------------------------------------------

export async function ensureVaultRepo(
  vaultRoot: string,
  opts: { remoteUrl?: string; branch?: string },
): Promise<void> {
  const branch = opts.branch ?? "main";
  const { remoteUrl } = opts;
  mkdirSync(vaultRoot, { recursive: true });

  if (!existsSync(path.join(vaultRoot, ".git"))) {
    if (readdirSync(vaultRoot).length > 0) {
      throw new Error(`${vaultRoot} is not a git repository and is not empty; refusing to initialize`);
    }
    if (remoteUrl) {
      try {
        await git(["clone", "-c", "core.symlinks=false", "--branch", branch, remoteUrl, "."], vaultRoot, NETWORK_TIMEOUT_MS * 4);
      } catch (err) {
        // A brand-new empty remote has no branch to clone: start locally instead.
        let emptyRemote = false;
        try {
          emptyRemote = !(await git(["ls-remote", "--heads", remoteUrl], vaultRoot, NETWORK_TIMEOUT_MS)).trim();
        } catch {
          /* unreachable: report the clone error */
        }
        if (!emptyRemote) throw new Error(`git clone failed: ${errText(err)}`);
        rmSync(path.join(vaultRoot, ".git"), { recursive: true, force: true });
        await git(["init", "-b", branch], vaultRoot);
        await git(["remote", "add", "origin", remoteUrl], vaultRoot);
      }
    } else {
      await git(["init", "-b", branch], vaultRoot);
      console.warn("vault has no git remote: writes will not be replicated");
    }
  }

  await git(["config", "core.symlinks", "false"], vaultRoot);

  let origin: string | null = null;
  try {
    origin = (await git(["remote", "get-url", "origin"], vaultRoot)).trim();
  } catch {
    /* no origin */
  }
  if (remoteUrl) {
    if (origin === null) await git(["remote", "add", "origin", remoteUrl], vaultRoot);
    else if (origin !== remoteUrl) {
      throw new Error(`existing origin remote points elsewhere (${redact(origin)}); expected ${redact(remoteUrl)}`);
    }
  }
  if (origin === null && !remoteUrl) return;

  const current = (await git(["symbolic-ref", "--short", "HEAD"], vaultRoot)).trim();
  if (current !== branch) {
    throw new Error(`vault is on branch "${current}" but "${branch}" was requested`);
  }
  if (!(await hasUpstream(vaultRoot))) {
    try {
      await git(["fetch", "origin"], vaultRoot, NETWORK_TIMEOUT_MS);
    } catch (err) {
      console.error(`startup fetch failed: ${errText(err)}`);
      return;
    }
    try {
      await git(["rev-parse", "--verify", `origin/${branch}`], vaultRoot);
      await git(["branch", `--set-upstream-to=origin/${branch}`], vaultRoot);
    } catch {
      /* remote has no such branch yet; first push sets upstream */
    }
  }
}
