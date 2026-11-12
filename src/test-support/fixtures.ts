// Shared test fixtures (temp dirs, git repos, temp DB). Excluded from the build
// via tsconfig "exclude". Every temp dir is tracked and removed by cleanup().
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep push-retry backoff short in tests (production default is 1000 ms).
process.env.SB_PUSH_BACKOFF_MS ??= "20";

const dirs: string[] = [];

/** New tracked temp dir; removed by cleanup(). */
export function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `sb-${prefix}-`));
  dirs.push(d);
  return d;
}

/** Remove every dir created through this module. Use as `after(cleanup)`. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Point DB_PATH at a throwaway file and return its path. db.ts reads the env
 * var at import time, so call this at module top level and load db.ts (and
 * anything importing it) via dynamic import in `before()`, never statically.
 */
export function makeTempDb(name = "test.db"): string {
  const path = join(tmp("db"), name);
  process.env.DB_PATH = path;
  return path;
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function configure(dir: string): void {
  git(["config", "user.name", "Test User"], dir);
  git(["config", "user.email", "test@example.com"], dir);
}

/** Empty git repo on branch main (independent of the host's init.defaultBranch). */
export function newRepo(prefix = "repo"): string {
  const dir = tmp(prefix);
  git(["init", "-b", "main"], dir);
  configure(dir);
  return dir;
}

export function makeBareRemote(): string {
  const dir = tmp("remote");
  git(["init", "--bare", "-b", "main"], dir);
  return dir;
}

/** Clone of `remote` on a local main branch, with identity configured. */
export function cloneRepo(remote: string, prefix = "clone"): string {
  const dir = tmp(prefix);
  git(["clone", remote, "."], dir);
  git(["checkout", "-B", "main"], dir);
  configure(dir);
  return dir;
}

/**
 * A vault repo. With `remote: true` it is a clone of a fresh bare remote with
 * one seed commit already pushed (upstream tracking set).
 */
export function makeTempVault(opts: { remote?: boolean } = {}): { vault: string; remote?: string } {
  if (!opts.remote) return { vault: newRepo("vault") };
  const remote = makeBareRemote();
  const vault = cloneRepo(remote, "vault");
  writeFileSync(join(vault, "seed.md"), "seed\n");
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);
  git(["push", "-u", "origin", "main"], vault);
  return { vault, remote };
}
