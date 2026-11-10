import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// No remote configured is the normal local-dev case, not an error.
export function hasRemote(vaultRoot: string): boolean {
  return git(["remote"], vaultRoot).trim().length > 0;
}

export function pullRebase(vaultRoot: string): void {
  if (!hasRemote(vaultRoot)) return;
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
  git(["add", relativePath], vaultRoot);
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
    execFile("git", args, { cwd }, (err) => (err ? reject(err) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Fire-and-forget: never throws back to the caller, push happens in the background.
export function queuePush(vaultRoot: string): void {
  if (!hasRemote(vaultRoot)) return;
  void pushWithRetry(vaultRoot);
}

// Single in-process mutex so concurrent calls serialize instead of interleaving
// git operations on the same working tree. Simple promise-chaining, no new dep.
let queue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function syncWrite(
  vaultRoot: string,
  relativePath: string,
  content: string,
  commitMessage: string,
): Promise<{ commitSha: string }> {
  return withLock(() => {
    pullRebase(vaultRoot);
    const absolutePath = path.join(vaultRoot, relativePath);
    writeNoteAtomic(absolutePath, content);
    const commitSha = commitFile(vaultRoot, relativePath, commitMessage);
    queuePush(vaultRoot);
    return { commitSha };
  });
}
