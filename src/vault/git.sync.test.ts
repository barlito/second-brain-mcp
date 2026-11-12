import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  drainWrites,
  ensureVaultRepo,
  getSyncStatus,
  hasRemote,
  VaultBusyError,
  pullRebase,
  startPeriodicSync,
  syncWrite,
} from "./git";
import { cleanup, cloneRepo, git, makeBareRemote, newRepo, sleep, tmp } from "../test-support/fixtures";
import { newVaultWithRemote, otherClone } from "../test-support/git-helpers";

after(cleanup);

test("hasRemote false without a remote; pullRebase is a no-op", async () => {
  const repo = newRepo();
  assert.equal(await hasRemote(repo), false);
  await assert.doesNotReject(pullRebase(repo));
});

test("pull with a dirty tree (modified tracked file) autostashes instead of failing", async () => {
  const { vault, remote } = newVaultWithRemote();
  const other = otherClone(remote);
  writeFileSync(join(other, "theirs.md"), "t\n");
  git(["add", "."], other);
  git(["commit", "-m", "t"], other);
  git(["push"], other);
  writeFileSync(join(vault, "seed.md"), "human edit\n");
  await syncWrite(vault, join(vault, "mine.md"), "m\n", "m");
  await drainWrites();
  assert.equal(readFileSync(join(vault, "seed.md"), "utf8"), "human edit\n");
  assert.equal(git(["show", "main:theirs.md"], remote), "t\n");
  assert.equal(git(["show", "main:mine.md"], remote), "m\n");
  assert.equal(getSyncStatus(vault).lastError, null);
});

test("pull works when the remote was added without upstream tracking", async () => {
  const remote = makeBareRemote();
  const seed = cloneRepo(remote, "seed");
  writeFileSync(join(seed, "a.md"), "a\n");
  git(["add", "."], seed);
  git(["commit", "-m", "a"], seed);
  git(["push", "-u", "origin", "main"], seed);

  const vault = newRepo();
  git(["remote", "add", "origin", remote], vault);
  git(["pull", "origin", "main"], vault);
  assert.throws(() => git(["rev-parse", "--abbrev-ref", "@{u}"], vault), /./); // no upstream
  writeFileSync(join(seed, "b.md"), "b\n");
  git(["add", "."], seed);
  git(["commit", "-m", "b"], seed);
  git(["push"], seed);

  await pullRebase(vault);
  assert.equal(readFileSync(join(vault, "b.md"), "utf8"), "b\n");
  await syncWrite(vault, join(vault, "c.md"), "c\n", "c");
  await drainWrites();
  assert.equal(git(["show", "main:c.md"], remote), "c\n");
});

test("self-heal: a stale index.lock is cleared before a write", async () => {
  const repo = newRepo();
  await syncWrite(repo, join(repo, "a.md"), "a\n", "a");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lock, old, old);
  await syncWrite(repo, join(repo, "b.md"), "b\n", "b");
  assert.equal(existsSync(lock), false);
});

test("a fresh index.lock fails the write as busy and is left alone", async () => {
  const repo = newRepo();
  await syncWrite(repo, join(repo, "a.md"), "a\n", "a");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  await assert.rejects(syncWrite(repo, join(repo, "b.md"), "b\n", "b"), VaultBusyError);
  assert.equal(existsSync(lock), true);
});

test("a foreign in-progress rebase is not aborted; a server-marked one is healed", async () => {
  const repo = newRepo();
  await syncWrite(repo, join(repo, "a.md"), "a\n", "a");
  mkdirSync(join(repo, ".git", "rebase-merge"));
  await assert.rejects(syncWrite(repo, join(repo, "b.md"), "b\n", "b"), /rebase in progress/);
  assert.equal(existsSync(join(repo, ".git", "rebase-merge")), true);
  // With our marker it is ours: selfHeal tries to abort it and clears the marker.
  writeFileSync(join(repo, ".git", "second-brain-rebase"), "1");
  rmSync(join(repo, ".git", "rebase-merge"), { recursive: true });
  await syncWrite(repo, join(repo, "b.md"), "b\n", "b");
  assert.equal(existsSync(join(repo, ".git", "second-brain-rebase")), false);
});

test("ensureVaultRepo clone does not check out symlinks", async () => {
  const { vault, remote } = newVaultWithRemote();
  symlinkSync("/etc/passwd", join(vault, "link.md"));
  git(["add", "link.md"], vault);
  git(["commit", "-m", "symlink"], vault);
  git(["push"], vault);
  const dir = tmp("clone");
  await ensureVaultRepo(dir, { remoteUrl: remote });
  assert.equal(lstatSync(join(dir, "link.md")).isSymbolicLink(), false);
  assert.ok(lstatSync(join(dir, "link.md")).isFile());
});

test("ensureVaultRepo clones from a bare remote into an empty dir and sets core.symlinks=false", async () => {
  const { remote } = newVaultWithRemote();
  const dir = tmp("clone");
  await ensureVaultRepo(dir, { remoteUrl: remote });
  assert.ok(existsSync(join(dir, "seed.md")));
  assert.equal(git(["config", "core.symlinks"], dir).trim(), "false");
  assert.equal(git(["rev-parse", "--abbrev-ref", "@{u}"], dir).trim(), "origin/main");
  // idempotent
  await ensureVaultRepo(dir, { remoteUrl: remote });
});

test("ensureVaultRepo inits (with a warning) when there is no remote", async () => {
  const dir = tmp("init");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await ensureVaultRepo(dir, { branch: "trunk" });
  } finally {
    console.warn = orig;
  }
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], dir).trim(), "trunk");
  assert.equal(git(["config", "core.symlinks"], dir).trim(), "false");
  assert.ok(warns.some((w) => w.includes("not be replicated")));
});

test("ensureVaultRepo refuses a non-empty non-repo dir and a mismatched origin", async () => {
  const dir = tmp("dirty");
  writeFileSync(join(dir, "stuff"), "x");
  await assert.rejects(ensureVaultRepo(dir, {}), /not empty/);

  const { vault } = newVaultWithRemote();
  await assert.rejects(ensureVaultRepo(vault, { remoteUrl: "/somewhere/else.git" }), /points elsewhere/);
});

test("ensureVaultRepo sets the upstream when the branch has none", async () => {
  const { vault } = newVaultWithRemote();
  git(["branch", "--unset-upstream"], vault);
  await ensureVaultRepo(vault, {});
  assert.equal(git(["rev-parse", "--abbrev-ref", "@{u}"], vault).trim(), "origin/main");
});

test("startPeriodicSync picks up commits pushed by someone else", async () => {
  const { vault, remote } = newVaultWithRemote();
  const other = otherClone(remote);
  writeFileSync(join(other, "from-other.md"), "hello\n");
  git(["add", "."], other);
  git(["commit", "-m", "other"], other);
  git(["push"], other);

  const stop = startPeriodicSync(vault, 50);
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(vault, "from-other.md")) && Date.now() < deadline) await sleep(50);
    assert.equal(readFileSync(join(vault, "from-other.md"), "utf8"), "hello\n");
  } finally {
    stop();
    await drainWrites();
  }
});

test("startPeriodicSync pushes leftover local commits", async () => {
  const { vault, remote } = newVaultWithRemote();
  writeFileSync(join(vault, "local.md"), "l\n");
  git(["add", "."], vault);
  git(["commit", "-m", "local"], vault);
  const stop = startPeriodicSync(vault, 50);
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (git(["show", "main:local.md"], remote) === "l\n") break;
      } catch {
        /* not yet */
      }
      await sleep(50);
    }
    assert.equal(git(["show", "main:local.md"], remote), "l\n");
  } finally {
    stop();
    await drainWrites();
  }
});

// ---- op marker / crash-safe lock recovery / push abort --------------------

test("op marker: absent after a write, and a foreign lock without it survives startup", async () => {
  const repo = newRepo();
  mkdirSync(join(repo, "p"), { recursive: true });
  await syncWrite(repo, join(repo, "p", "a.md"), "a\n", "a");
  await drainWrites();
  assert.equal(existsSync(join(repo, ".git", "second-brain-op")), false);

  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  await ensureVaultRepo(repo, {});
  assert.ok(existsSync(lock), "lock without marker is a human's: left alone");
});

test("op marker: leftover marker at startup means we died mid-op, so index.lock and marker are removed", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, ".git", "second-brain-op"), "123");
  writeFileSync(join(repo, ".git", "index.lock"), "");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await ensureVaultRepo(repo, {});
  } finally {
    console.warn = orig;
  }
  assert.equal(existsSync(join(repo, ".git", "index.lock")), false);
  assert.equal(existsSync(join(repo, ".git", "second-brain-op")), false);
  assert.ok(warns.some((w) => w.includes("died mid-operation")));
});

test("op marker is present while a write is in flight", async () => {
  const repo = newRepo();
  mkdirSync(join(repo, "p"), { recursive: true });
  const w = syncWrite(repo, join(repo, "p", "a.md"), "a\n", "a");
  await sleep(0);
  assert.ok(existsSync(join(repo, ".git", "second-brain-op")));
  await w;
  await drainWrites();
});
