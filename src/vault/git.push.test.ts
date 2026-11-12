import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  abortPendingPushes,
  drainWrites,
  getSyncStatus,
  resetPushAbort,
  SyncConflictError,
  syncWrite,
} from "./git";
import { cleanup, git, newRepo, sleep, tmp } from "../test-support/fixtures";
import { newVaultWithRemote, otherClone } from "../test-support/git-helpers";

after(cleanup);

test("push to a bare remote succeeds and is visible there", async () => {
  const { vault, remote } = newVaultWithRemote();
  const { commitSha } = await syncWrite(vault, join(vault, "p", "s", "n.md"), "hi\n", "remote write");
  await drainWrites();
  assert.equal(git(["rev-parse", "main"], remote).trim(), commitSha);
  const s = getSyncStatus(vault);
  assert.equal(s.unpushed, false);
  assert.equal(s.lastPushOk, true);
});

test("unreachable remote: write succeeds, push is retried and status reports failure", async () => {
  const { vault } = newVaultWithRemote();
  git(["remote", "set-url", "origin", join(tmp("gone"), "nope.git")], vault);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const { commitSha } = await syncWrite(vault, join(vault, "n.md"), "x\n", "offline write");
    assert.match(commitSha ?? "", /^[0-9a-f]{40}$/);
    await drainWrites();
  } finally {
    console.error = orig;
  }
  const s = getSyncStatus(vault);
  assert.equal(s.unpushed, true);
  assert.equal(s.lastPushOk, false);
  assert.ok(s.lastError);
  assert.ok(errors.some((e) => e.includes("git push failed")));
});

test("credentials in URLs are stripped from logged push failures", async () => {
  const { vault } = newVaultWithRemote();
  git(["remote", "set-url", "origin", "http://user:s3cret@127.0.0.1:1/x.git"], vault);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    await syncWrite(vault, join(vault, "n.md"), "x\n", "w");
    await drainWrites();
  } finally {
    console.error = orig;
  }
  assert.ok(errors.length > 0);
  assert.ok(!errors.join("\n").includes("s3cret"));
});

test("push retry pulls first when the remote has diverged (non-conflicting)", async () => {
  const { vault, remote } = newVaultWithRemote();
  const other = otherClone(remote);
  // Make the pre-write pull a no-op by pushing from `other` only after it ran:
  // a pre-receive hook can't do that, so simulate via a stale upstream ref.
  writeFileSync(join(other, "theirs.md"), "theirs\n");
  git(["add", "."], other);
  git(["commit", "-m", "theirs"], other);
  git(["push"], other);
  // Block the pull by pointing at the remote only for push: use pushurl.
  git(["config", "remote.origin.pushurl", remote], vault);
  git(["config", "remote.origin.url", join(tmp("gone"), "nope.git")], vault);
  await syncWrite(vault, join(vault, "mine.md"), "mine\n", "mine");
  // Restore the real url so the retry's pull works; the retry pulls then pushes.
  git(["config", "remote.origin.url", remote], vault);
  await drainWrites();
  assert.equal(getSyncStatus(vault).lastPushOk, true);
  assert.equal(git(["show", "main:theirs.md"], remote), "theirs\n");
  assert.equal(git(["show", "main:mine.md"], remote), "mine\n");
});

test("conflicting diverged remote: backup branch keeps local commit, branch reset to remote, next write succeeds", async () => {
  const { vault, remote } = newVaultWithRemote();
  await syncWrite(vault, join(vault, "note.md"), "base\n", "base");
  await drainWrites();
  const other = otherClone(remote);

  // Local unpushed commit editing note.md...
  writeFileSync(join(vault, "note.md"), "local\n");
  git(["commit", "-am", "local edit"], vault);
  const localSha = git(["rev-parse", "HEAD"], vault).trim();
  // ...and a conflicting remote edit.
  writeFileSync(join(other, "note.md"), "remote\n");
  git(["commit", "-am", "remote edit"], other);
  git(["push"], other);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  let err: unknown;
  try {
    err = await syncWrite(vault, join(vault, "other.md"), "o\n", "o").catch((e) => e);
    await drainWrites();
  } finally {
    console.error = orig;
  }
  assert.ok(err instanceof SyncConflictError);
  assert.ok(errs.some((e) => e.includes("SYNC CONFLICT")));
  const backup = (err as SyncConflictError).backupBranch!;
  assert.match(backup, /^conflict\//);
  assert.equal(git(["rev-parse", backup], vault).trim(), localSha);
  assert.equal(git(["show", `${backup}:note.md`], vault), "local\n");
  assert.equal(git(["rev-parse", backup], remote).trim(), localSha); // pushed for the human
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), git(["rev-parse", "origin/main"], vault).trim());
  assert.equal(readFileSync(join(vault, "note.md"), "utf8"), "remote\n");
  assert.equal(existsSync(join(vault, ".git", "rebase-merge")), false);
  assert.equal(git(["status", "--porcelain"], vault), "");
  assert.equal(existsSync(join(vault, "other.md")), false);
  assert.deepEqual(getSyncStatus(vault).conflictBranches, [backup]);
  assert.equal(getSyncStatus(vault).lastError?.kind, "conflict");

  await syncWrite(vault, join(vault, "other.md"), "o\n", "o");
  await drainWrites();
  assert.equal(git(["show", "main:other.md"], remote), "o\n");
});

test("conflict recovery parks only the conflicting local commits; clean ones are re-applied and pushed", async () => {
  const { vault, remote } = newVaultWithRemote();
  await syncWrite(vault, join(vault, "note.md"), "base\n", "base");
  await drainWrites();
  const other = otherClone(remote);
  // Unpushed local commits: clean, conflicting, clean.
  writeFileSync(join(vault, "b1.md"), "b1\n");
  git(["add", "b1.md"], vault);
  git(["commit", "-m", "kb_write: sp/p/s/b1 via alice"], vault);
  writeFileSync(join(vault, "note.md"), "local\n");
  git(["commit", "-am", "kb_write: sp/p/s/note via bob"], vault);
  const conflicting = git(["rev-parse", "HEAD"], vault).trim();
  writeFileSync(join(vault, "b2.md"), "b2\n");
  git(["add", "b2.md"], vault);
  git(["commit", "-m", "kb_write: sp/p/s/b2 via carol"], vault);
  const before = git(["rev-parse", "HEAD"], vault).trim();
  writeFileSync(join(other, "note.md"), "remote\n");
  git(["commit", "-am", "remote edit"], other);
  git(["push"], other);

  const { setSyncEventHandler } = await import("./git");
  const events: import("./git").SyncConflictEvent[] = [];
  setSyncEventHandler((e) => void events.push(e));
  const orig = console.error;
  console.error = () => undefined;
  let err: unknown;
  try {
    err = await syncWrite(vault, join(vault, "x.md"), "x\n", "x").catch((e) => e);
  } finally {
    console.error = orig;
    setSyncEventHandler(null);
  }
  await drainWrites();
  assert.ok(err instanceof SyncConflictError);
  const e = err as SyncConflictError;
  assert.deepEqual(e.paths, ["note.md"]);
  assert.equal(e.reapplied, 2);
  assert.match(e.message, /1 conflicting local commit\(s\) parked.*2 other local commit\(s\) kept.*not applied/);
  // Safety net: the backup branch holds the full pre-reset state.
  assert.equal(git(["rev-parse", e.backupBranch!], vault).trim(), before);
  // Branch: remote + the two clean commits, in order; the conflicting one is not there.
  assert.deepEqual(git(["log", "--format=%s", "origin/main..HEAD"], vault).trim().split("\n"), [
    "kb_write: sp/p/s/b2 via carol",
    "kb_write: sp/p/s/b1 via alice",
  ]);
  assert.equal(readFileSync(join(vault, "note.md"), "utf8"), "remote\n");
  assert.equal(readFileSync(join(vault, "b1.md"), "utf8"), "b1\n");
  assert.equal(git(["status", "--porcelain"], vault), "");
  assert.equal(existsSync(join(vault, "x.md")), false, "the triggering write was not applied");
  assert.equal(getSyncStatus(vault).unpushed, true);
  // Event lists only the parked commit.
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].commits, [conflicting]);
  assert.deepEqual(events[0].tokens, ["bob"]);
  assert.equal(events[0].reapplied, 2);
  assert.deepEqual(events[0].parked, [{ sha: conflicting, subject: "kb_write: sp/p/s/note via bob", paths: ["note.md"] }]);

  // The retry lands and pushes the re-applied commits too.
  await syncWrite(vault, join(vault, "x.md"), "x\n", "x");
  await drainWrites();
  assert.equal(git(["show", "main:b1.md"], remote), "b1\n");
  assert.equal(git(["show", "main:b2.md"], remote), "b2\n");
  assert.equal(git(["show", "main:note.md"], remote), "remote\n");
});

test("conflict recovery falls back to parking everything when local history cannot be replayed (merge)", async () => {
  const { vault, remote } = newVaultWithRemote();
  await syncWrite(vault, join(vault, "note.md"), "base\n", "base");
  await drainWrites();
  const other = otherClone(remote);
  git(["checkout", "-q", "-b", "side"], vault);
  writeFileSync(join(vault, "side.md"), "s\n");
  git(["add", "side.md"], vault);
  git(["commit", "-m", "side"], vault);
  git(["checkout", "-q", "main"], vault);
  writeFileSync(join(vault, "note.md"), "local\n");
  git(["commit", "-am", "local edit"], vault);
  git(["merge", "-q", "--no-ff", "-m", "merge side", "side"], vault);
  const before = git(["rev-parse", "HEAD"], vault).trim();
  writeFileSync(join(other, "note.md"), "remote\n");
  git(["commit", "-am", "remote edit"], other);
  git(["push"], other);

  const orig = console.error;
  console.error = () => undefined;
  let err: unknown;
  try {
    err = await syncWrite(vault, join(vault, "x.md"), "x\n", "x").catch((e) => e);
  } finally {
    console.error = orig;
  }
  await drainWrites();
  assert.ok(err instanceof SyncConflictError);
  assert.equal((err as SyncConflictError).reapplied, 0);
  assert.equal(git(["rev-parse", (err as SyncConflictError).backupBranch!], vault).trim(), before);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), git(["rev-parse", "origin/main"], vault).trim());
  assert.equal(existsSync(join(vault, ".git", "CHERRY_PICK_HEAD")), false);
  assert.equal(git(["status", "--porcelain"], vault), "");
});

test("autostash re-apply conflict is treated as a conflict; human change kept in stash", async () => {
  const { vault, remote } = newVaultWithRemote();
  const other = otherClone(remote);
  writeFileSync(join(other, "seed.md"), "remote\n");
  git(["commit", "-am", "r"], other);
  git(["push"], other);
  writeFileSync(join(vault, "seed.md"), "human\n");
  const orig = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(syncWrite(vault, join(vault, "x.md"), "x\n", "x"), SyncConflictError);
  } finally {
    console.error = orig;
  }
  assert.match(git(["stash", "list"], vault), /./);
  assert.equal(git(["status", "--porcelain"], vault), "");
  await syncWrite(vault, join(vault, "x.md"), "x\n", "x");
  await drainWrites();
});

test("sync status is per vault and unpushed stays false without a remote", async () => {
  const a = newRepo();
  const { vault: b } = newVaultWithRemote();
  await syncWrite(a, join(a, "n.md"), "n\n", "n");
  assert.equal(getSyncStatus(a).unpushed, false);
  git(["remote", "set-url", "origin", join(tmp("gone"), "x.git")], b);
  const orig = console.error;
  console.error = () => undefined;
  try {
    await syncWrite(b, join(b, "n.md"), "n\n", "n");
    await drainWrites();
  } finally {
    console.error = orig;
  }
  assert.equal(getSyncStatus(b).unpushed, true);
  assert.equal(getSyncStatus(b).lastError?.kind, "network");
  assert.equal(getSyncStatus(a).unpushed, false);
  assert.equal(getSyncStatus(a).lastError, null);
});

test("push deadline kills a hung push: queue settles and no local push process lingers", async () => {
  const { vault, remote } = newVaultWithRemote();
  const gate = join(tmp("gate"), "never");
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);
  process.env.SB_PUSH_DEADLINE_MS = "1500";
  const orig = console.error;
  console.error = () => undefined;
  try {
    const t0 = Date.now();
    await syncWrite(vault, join(vault, "one.md"), "1\n", "one");
    await drainWrites();
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    console.error = orig;
    delete process.env.SB_PUSH_DEADLINE_MS;
    writeFileSync(gate, ""); // release the orphaned remote-side hook
  }
  const s = getSyncStatus(vault);
  assert.equal(s.lastPushOk, false);
  assert.equal(s.unpushed, true);
  assert.equal(s.lastError?.kind, "network");
});

test("a hung push does not hold the write queue; later commits are pushed by one coalesced follow-up", async () => {
  const { vault, remote } = newVaultWithRemote();
  const gate = join(tmp("gate"), "open");
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);

  await syncWrite(vault, join(vault, "one.md"), "1\n", "one");
  await sleep(200); // the background push is now stuck in the hook
  // Writes keep landing locally while the push hangs.
  await Promise.all([1, 2, 3, 4, 5].map((i) => syncWrite(vault, join(vault, `w${i}.md`), `${i}\n`, `w${i}`)));
  assert.equal(git(["rev-list", "--count", "HEAD"], vault).trim(), "7"); // seed + one + five
  assert.equal(getSyncStatus(vault).unpushed, true);
  writeFileSync(gate, "");
  await drainWrites();
  assert.equal(git(["rev-parse", "main"], remote).trim(), git(["rev-parse", "HEAD"], vault).trim());
  const s = getSyncStatus(vault);
  assert.equal(s.unpushed, false);
  assert.equal(s.lastPushOk, true);
});

test("after a network error the pre-write pull is skipped; the pusher rebases onto the remote later", async () => {
  const { vault, remote } = newVaultWithRemote();
  const realUrl = git(["remote", "get-url", "origin"], vault).trim();
  git(["remote", "set-url", "origin", join(tmp("gone"), "nope.git")], vault);
  const orig = console.error;
  console.error = () => undefined;
  try {
    await syncWrite(vault, join(vault, "a.md"), "a\n", "a");
    await drainWrites(); // push cycle fails: remote marked down
    assert.equal(getSyncStatus(vault).lastError?.kind, "network");

    git(["remote", "set-url", "origin", realUrl], vault);
    const other = otherClone(remote);
    writeFileSync(join(other, "theirs.md"), "t\n");
    git(["add", "."], other);
    git(["commit", "-m", "theirs"], other);
    git(["push"], other);

    await syncWrite(vault, join(vault, "b.md"), "b\n", "b");
    assert.equal(existsSync(join(vault, "theirs.md")), false, "pre-write pull must be skipped");
    await drainWrites();
  } finally {
    console.error = orig;
  }
  // The push was rejected (non-fast-forward), so the pusher pulled and pushed again.
  assert.equal(readFileSync(join(vault, "theirs.md"), "utf8"), "t\n");
  assert.equal(git(["show", "main:b.md"], remote), "b\n");
  assert.equal(git(["show", "main:a.md"], remote), "a\n");
  const s = getSyncStatus(vault);
  assert.equal(s.unpushed, false);
  assert.equal(s.lastPushOk, true);
  assert.equal(s.lastError, null);
});

test("abortPendingPushes: pending push is abandoned, the commit still lands", async () => {
  const { vault } = newVaultWithRemote();
  abortPendingPushes();
  try {
    mkdirSync(join(vault, "p"), { recursive: true });
    const { commitSha } = await syncWrite(vault, join(vault, "p", "a.md"), "a\n", "a");
    await drainWrites();
    assert.equal(git(["rev-parse", "HEAD"], vault).trim(), commitSha);
    const s = getSyncStatus(vault);
    assert.equal(s.lastPushOk, false);
    assert.match(s.lastError?.message ?? "", /push aborted/);
    assert.equal(s.unpushed, true);
  } finally {
    resetPushAbort();
  }
});
