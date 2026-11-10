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
  writeSync,
} from "node:fs";
import path from "node:path";

import { assertSafePath } from "./paths";

const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 30_000;
// Upper bound on how long the lock queue waits for a background push, so one
// hung push can never wedge all future writes.
const PUSH_SETTLE_MAX_MS = 120_000;
const PUSH_RETRIES = 3;
const PUSH_BACKOFF_MS = 1000;

// LANG/LC_ALL=C: error-message matching must not depend on the locale.
// GIT_TERMINAL_PROMPT=0: never block waiting for credentials on a tty.
const GIT_ENV = { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

function git(args: string[], cwd: string, timeout = LOCAL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", env: GIT_ENV, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        Object.assign(err, { stdout, stderr });
        reject(err);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(text: string): string {
  return text.replace(/:\/\/[^@/\s]+@/g, "://***@");
}

function errText(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return redact(`${e.message ?? String(err)} ${e.stderr ?? ""}`.trim());
}

// ---- sync status ---------------------------------------------------------

export interface SyncStatus {
  unpushed: boolean;
  lastPushAt: string | null;
  lastPushOk: boolean | null;
  lastPullAt: string | null;
  lastError: string | null;
}

const status: SyncStatus = {
  unpushed: false,
  lastPushAt: null,
  lastPushOk: null,
  lastPullAt: null,
  lastError: null,
};

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

// ---- git primitives ------------------------------------------------------

// No remote configured is the normal local-dev case, not an error.
export async function hasRemote(vaultRoot: string): Promise<boolean> {
  return (await git(["remote"], vaultRoot)).trim().length > 0;
}

async function hasUpstream(vaultRoot: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--abbrev-ref", "@{u}"], vaultRoot);
    return true;
  } catch {
    return false;
  }
}

function rebaseInProgress(vaultRoot: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((d) => existsSync(path.join(vaultRoot, ".git", d)));
}

// Aborts a half-done rebase (if any); never throws. Returns whether one existed.
async function abortRebase(vaultRoot: string): Promise<boolean> {
  const was = rebaseInProgress(vaultRoot);
  try {
    await git(["rebase", "--abort"], vaultRoot);
  } catch {
    /* nothing to abort, or already gone */
  }
  return was;
}

// Runs under the lock, which makes us the only writer: whatever is left behind
// is from a crash.
async function selfHeal(vaultRoot: string): Promise<void> {
  if (rebaseInProgress(vaultRoot)) await abortRebase(vaultRoot);
  rmSync(path.join(vaultRoot, ".git", "index.lock"), { force: true });
}

export class PullConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullConflictError";
  }
}

// Rebase conflicts are aborted and thrown; other failures (network down) are
// thrown as plain errors, with the repo untouched.
export async function pullRebase(vaultRoot: string): Promise<void> {
  if (!(await hasUpstream(vaultRoot))) return;
  try {
    await git(["pull", "--rebase"], vaultRoot, NETWORK_TIMEOUT_MS);
    status.lastPullAt = new Date().toISOString();
  } catch (err) {
    const conflicted = await abortRebase(vaultRoot);
    if (conflicted) throw new PullConflictError(`git pull --rebase conflicted: ${errText(err)}`);
    throw err;
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

function isNothingToCommit(err: unknown): boolean {
  const output = `${(err as { stdout?: string }).stdout ?? ""}${(err as Error).message ?? ""}`;
  return output.includes("nothing to commit") || output.includes("no changes added to commit");
}

export async function commitFile(
  vaultRoot: string,
  relativePath: string,
  message: string,
): Promise<string> {
  await git(["add", "--", relativePath], vaultRoot);
  try {
    // Pathspec: never sweep in other staged changes (e.g. a human's drafts).
    await git(["commit", "-m", message, "--", relativePath], vaultRoot);
  } catch (err) {
    if (!isNothingToCommit(err)) throw err;
  }
  return (await git(["rev-parse", "HEAD"], vaultRoot)).trim();
}

// ---- push ----------------------------------------------------------------

async function pushOnce(vaultRoot: string): Promise<void> {
  if (await hasUpstream(vaultRoot)) {
    await git(["push"], vaultRoot, NETWORK_TIMEOUT_MS);
  } else {
    const branch = (await git(["symbolic-ref", "--short", "HEAD"], vaultRoot)).trim();
    await git(["push", "-u", "origin", branch], vaultRoot, NETWORK_TIMEOUT_MS);
  }
}

// Never rejects. Retries pull first (a rejected push is usually non-fast-forward).
async function pushWithRetry(vaultRoot: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        try {
          await pullRebase(vaultRoot);
        } catch (pullErr) {
          lastErr = pullErr;
          if (pullErr instanceof PullConflictError) break; // retrying can't help
        }
      }
      await pushOnce(vaultRoot);
      status.unpushed = false;
      status.lastPushOk = true;
      status.lastPushAt = new Date().toISOString();
      status.lastError = null;
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < PUSH_RETRIES) await sleep(PUSH_BACKOFF_MS * attempt);
    }
  }
  status.lastPushOk = false;
  status.lastPushAt = new Date().toISOString();
  status.lastError = errText(lastErr);
  console.error(`git push failed: ${status.lastError}`);
}

// ---- lock ----------------------------------------------------------------

// Single in-process mutex so concurrent calls serialize instead of interleaving
// git operations on the same working tree.
//
// The queue only advances once the *push* from the previous turn has settled
// (bounded by PUSH_SETTLE_MAX_MS) — otherwise the next turn's `git pull
// --rebase` could mutate refs while the push is still in flight.
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
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PUSH_SETTLE_MAX_MS);
        timer.unref();
      });
      await Promise.race([r.settle.catch(() => undefined), timeout]);
      clearTimeout(timer);
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
        if (err instanceof PullConflictError) throw err;
        // Remote unreachable: still commit locally; the push retry catches up.
        status.lastError = errText(err);
        console.error(`git pull failed, writing locally: ${status.lastError}`);
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

    status.unpushed = true;
    // Resolve the caller with the commit now — don't make them wait on network
    // push latency. The lock queue (settle) waits on it instead.
    const settle = remote ? pushWithRetry(vaultRoot) : Promise.resolve();
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
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await withLock(async () => {
        await selfHeal(vaultRoot);
        if (!(await hasRemote(vaultRoot))) return { value: undefined, settle: Promise.resolve() };
        try {
          await pullRebase(vaultRoot);
        } catch (err) {
          status.lastError = errText(err);
          console.error(`periodic sync pull failed: ${status.lastError}`);
          return { value: undefined, settle: Promise.resolve() };
        }
        if (!status.unpushed && !(await hasLocalOnlyCommits(vaultRoot))) {
          return { value: undefined, settle: Promise.resolve() };
        }
        status.unpushed = true;
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
    return parseInt(await git(["rev-list", "--count", "@{u}..HEAD"], vaultRoot), 10) > 0;
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
        await git(["clone", "--branch", branch, remoteUrl, "."], vaultRoot, NETWORK_TIMEOUT_MS * 4);
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
