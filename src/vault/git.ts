import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Force English output so error-message matching (e.g. isNothingToCommit)
// doesn't depend on the host/container's actual locale.
const GIT_ENV = { ...process.env, LANG: "C", LC_ALL: "C" };

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
}

// No remote configured is the normal local-dev case, not an error.
export function hasRemote(vaultRoot: string): boolean {
  return git(["remote"], vaultRoot).trim().length > 0;
}

export function pullRebase(vaultRoot: string, hasRemote: boolean): void {
  if (!hasRemote) return;
  git(["pull", "--rebase"], vaultRoot);
}

// Write-then-rename so a crash mid-write never leaves a half-written note.
export function writeNoteAtomic(absolutePath: string, content: string): void {
  const dir = path.dirname(absolutePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${absolutePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, absolutePath);
}

function isNothingToCommit(err: unknown): boolean {
  const output = `${(err as { stdout?: string }).stdout ?? ""}${(err as Error).message ?? ""}`;
  return output.includes("nothing to commit");
}

export function commitFile(vaultRoot: string, relativePath: string, message: string): string {
  git(["add", "--", relativePath], vaultRoot);
  try {
    git(["commit", "-m", message], vaultRoot);
  } catch (err) {
    if (!isNothingToCommit(err)) throw err;
  }
  return git(["rev-parse", "HEAD"], vaultRoot).trim();
}

const PUSH_RETRIES = 3;
const PUSH_BACKOFF_MS = 1000;

function execGitAsync(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: GIT_ENV }, (err) => (err ? reject(err) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported so tests can substitute a fake/slow push without a real remote.
export type PushFn = (vaultRoot: string) => Promise<void>;

async function pushWithRetry(vaultRoot: string): Promise<void> {
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
    try {
      await execGitAsync(["push"], vaultRoot);
      return;
    } catch (err) {
      if (attempt === PUSH_RETRIES) {
        console.error(`git push failed after ${PUSH_RETRIES} attempts:`, err);
        return;
      }
      await sleep(PUSH_BACKOFF_MS * attempt);
    }
  }
}

// Resolves once the push has settled (succeeded, or retries exhausted) — never
// rejects. Whether the caller waits on it is up to the caller (see syncWrite).
export function queuePush(
  vaultRoot: string,
  hasRemote: boolean,
  push: PushFn = pushWithRetry,
): Promise<void> {
  if (!hasRemote) return Promise.resolve();
  return push(vaultRoot);
}

// Single in-process mutex so concurrent calls serialize instead of interleaving
// git operations on the same working tree. Simple promise-chaining, no new dep.
//
// The queue only advances once the *push* from the previous syncWrite call has
// settled (not just once its synchronous commit returned) — otherwise a second
// syncWrite's pullRebase (a real `git pull --rebase`, mutating refs/working
// tree) could start while the first call's push is still in flight against the
// same .git directory.
interface LockedResult<T> {
  value: T;
  // Resolves when background work (the push) kicked off by this turn settles.
  settle: Promise<unknown>;
}

let queue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => LockedResult<T>): Promise<T> {
  const scheduled = queue.then(fn);
  queue = scheduled.then(
    (r) => r.settle.catch(() => undefined),
    () => undefined,
  );
  return scheduled.then((r) => r.value);
}

export function syncWrite(
  vaultRoot: string,
  absolutePath: string,
  content: string,
  commitMessage: string,
  push: PushFn = pushWithRetry,
): Promise<{ commitSha: string }> {
  return withLock(() => {
    const remote = hasRemote(vaultRoot);
    pullRebase(vaultRoot, remote);
    const relativePath = path.relative(vaultRoot, absolutePath);
    writeNoteAtomic(absolutePath, content);
    const commitSha = commitFile(vaultRoot, relativePath, commitMessage);
    const settle = queuePush(vaultRoot, remote, push);
    // Resolve the caller immediately with the commit — don't make them wait on
    // network push latency. The lock queue (settle) waits on it instead.
    return { value: { commitSha }, settle };
  });
}
