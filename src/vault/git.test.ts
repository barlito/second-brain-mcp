import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  abortPendingPushes,
  commitFile,
  drainWrites,
  ensureVaultRepo,
  getSyncStatus,
  hasRemote,
  redact,
  resetPushAbort,
  SyncConflictError,
  VaultBusyError,
  pullRebase,
  startPeriodicSync,
  syncWrite,
  syncAppend,
  syncMove,
  MoveSourceDirtyError,
  MoveSourceMissingError,
  NoteTooLargeError,
  NoteNotUtf8Error,
  MoveTargetExistsError,
  writeNoteAtomic,
} from "./git";
import { cleanup, cloneRepo, git, makeBareRemote, makeTempVault, newRepo, sleep, tmp } from "../test-support/fixtures";

after(cleanup);

// A vault clone with a seeded bare remote.
const newVaultWithRemote = () => makeTempVault({ remote: true }) as { vault: string; remote: string };

function otherClone(remote: string): string {
  return cloneRepo(remote, "other");
}

test("hasRemote false without a remote; pullRebase is a no-op", async () => {
  const repo = newRepo();
  assert.equal(await hasRemote(repo), false);
  await assert.doesNotReject(pullRebase(repo));
});

test("writeNoteAtomic + commitFile produce a real commit", async () => {
  const repo = newRepo();
  const abs = join(repo, "note.md");
  writeNoteAtomic(repo, abs, "# hello\n");
  const sha = await commitFile(repo, "note.md", "add note");
  assert.equal(readFileSync(abs, "utf8"), "# hello\n");
  assert.equal(sha, git(["rev-parse", "HEAD"], repo).trim());
  assert.match(git(["log", "--oneline", "-1"], repo), /add note/);
  // identical content again: nothing to commit, reports no commit (not HEAD)
  writeNoteAtomic(repo, abs, "# hello\n");
  assert.equal(await commitFile(repo, "note.md", "noop"), null);
  assert.deepEqual(readdirSync(repo).filter((f) => f.includes(".tmp-")), []);
});

test("commit only includes the target file even if another file is staged", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "draft.md"), "human draft\n");
  git(["add", "draft.md"], repo);
  await syncWrite(repo, join(repo, "note.md"), "x\n", "write note");
  assert.equal(git(["show", "--no-renames", "--name-only", "--format=", "HEAD"], repo).trim(), "note.md");
  assert.equal(git(["diff", "--cached", "--name-only"], repo).trim(), "draft.md");
});

test("truly concurrent syncWrite calls: one commit per file, no interleaving", async () => {
  const repo = newRepo();
  const names = ["a", "b", "c", "d"];
  const results = await Promise.all(
    names.map((n) => syncWrite(repo, join(repo, `${n}.md`), `${n}\n`, `write ${n}`)),
  );
  assert.equal(new Set(results.map((r) => r.commitSha)).size, 4);
  const log = git(["log", "--format=%H %s"], repo).trim().split("\n");
  assert.equal(log.length, 4);
  for (const n of names) {
    const line = log.find((l) => l.endsWith(`write ${n}`));
    assert.ok(line);
    const files = git(["show", "--no-renames", "--name-only", "--format=", line.split(" ")[0]], repo).trim();
    assert.equal(files, `${n}.md`);
  }
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("a failing locked operation does not wedge the queue", async () => {
  const repo = newRepo();
  const outside = tmp("outside");
  const failing = syncWrite(repo, join(outside, "x.md"), "x", "bad");
  const ok = syncWrite(repo, join(repo, "ok.md"), "ok\n", "good");
  await assert.rejects(failing);
  assert.match((await ok).commitSha ?? "", /^[0-9a-f]{40}$/);
  await drainWrites();
});

test("failed commit restores previous content and leaves a clean tree", async () => {
  const repo = newRepo();
  await syncWrite(repo, join(repo, "n.md"), "v1\n", "v1");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  await assert.rejects(syncWrite(repo, join(repo, "n.md"), "v2\n", "v2"));
  await assert.rejects(syncWrite(repo, join(repo, "new.md"), "new\n", "new"));
  assert.equal(readFileSync(join(repo, "n.md"), "utf8"), "v1\n");
  assert.equal(existsSync(join(repo, "new.md")), false);
  assert.equal(git(["status", "--porcelain"], repo), "");
  rmSync(hook);
  await syncWrite(repo, join(repo, "n.md"), "v3\n", "v3");
});

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
    assert.match(commitSha, /^[0-9a-f]{40}$/);
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

test("identical re-write succeeds even with untracked files present", async () => {
  const repo = newRepo();
  const { commitSha } = await syncWrite(repo, join(repo, "a.md"), "a\n", "a");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  const again = await syncWrite(repo, join(repo, "a.md"), "a\n", "a again");
  assert.ok(commitSha);
  assert.equal(again.commitSha, null); // nothing committed: HEAD is not reported as ours
  assert.equal(git(["rev-list", "--count", "HEAD"], repo).trim(), "1");
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

test("a hung push does not wedge later writes beyond the lock; push holds the queue until settled", async () => {
  const { vault, remote } = newVaultWithRemote();
  const gate = join(tmp("gate"), "open");
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);

  await syncWrite(vault, join(vault, "one.md"), "1\n", "one");
  let secondDone = false;
  const second = syncWrite(vault, join(vault, "two.md"), "2\n", "two").then((r) => {
    secondDone = true;
    return r;
  });
  await sleep(300);
  assert.equal(secondDone, false, "second write must wait for the first push");
  assert.equal(git(["rev-list", "--count", "HEAD"], vault).trim(), "2"); // seed + one
  writeFileSync(gate, "");
  await second;
  await drainWrites();
  assert.equal(git(["show", "main:two.md"], remote), "2\n");
});

test("symlinked section dir and note are rejected; nothing is written outside the vault", async () => {
  const repo = newRepo();
  const outside = tmp("outside");
  writeFileSync(join(outside, "secret.md"), "secret");
  mkdirSync(join(repo, "projb", "notes"), { recursive: true });
  mkdirSync(join(repo, "proja"));
  symlinkSync(join(repo, "projb", "notes"), join(repo, "proja", "notes"));
  symlinkSync(outside, join(repo, "evil"));
  mkdirSync(join(repo, "p2", "s"), { recursive: true });
  symlinkSync(join(outside, "secret.md"), join(repo, "p2", "s", "n.md"));

  await assert.rejects(syncWrite(repo, join(repo, "proja", "notes", "x.md"), "x", "m"), /symlink/);
  await assert.rejects(syncWrite(repo, join(repo, "evil", "x.md"), "x", "m"), /symlink/);
  await assert.rejects(syncWrite(repo, join(repo, "p2", "s", "n.md"), "pwned", "m"), /symlink/);
  assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "secret");
  assert.deepEqual(readdirSync(outside), ["secret.md"]);
  assert.deepEqual(readdirSync(join(repo, "projb", "notes")), []);
});

test("writeNoteAtomic: symlink in the parent path is rejected directly; temp name is unpredictable", () => {
  const repo = newRepo();
  const outside = tmp("outside");
  symlinkSync(outside, join(repo, "link"));
  assert.throws(() => writeNoteAtomic(repo, join(repo, "link", "n.md"), "x"), /symlink/);
  assert.deepEqual(readdirSync(outside), []);

  // A symlink planted at the old PID-based temp name must not be followed.
  mkdirSync(join(repo, "d"));
  const victim = join(outside, "victim");
  symlinkSync(victim, join(repo, "d", `n.md.tmp-${process.pid}`));
  writeNoteAtomic(repo, join(repo, "d", "n.md"), "ok");
  assert.equal(existsSync(victim), false);
  assert.equal(readFileSync(join(repo, "d", "n.md"), "utf8"), "ok");
  assert.ok(lstatSync(join(repo, "d", `n.md.tmp-${process.pid}`)).isSymbolicLink());
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

test("redact strips URL credentials", () => {
  assert.equal(redact("fatal: https://user:tok@host/x.git"), "fatal: https://***@host/x.git");
});

test("syncAppend: 10 concurrent appends all land, one commit each", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "seed.md"), "s\n");
  git(["add", "."], repo);
  git(["commit", "-m", "seed"], repo);
  const abs = join(repo, "a", "b", "journal", "2026-11.md");
  const before = Number(git(["rev-list", "--count", "HEAD"], repo));
  await Promise.all(Array.from({ length: 10 }, (_, i) => syncAppend(repo, abs, `- e${i}`, `append ${i}`)));
  const lines = readFileSync(abs, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 10);
  for (let i = 0; i < 10; i++) assert.ok(lines.includes(`- e${i}`));
  assert.equal(Number(git(["rev-list", "--count", "HEAD"], repo)) - before, 10);
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("syncAppend: newline handling for existing files", async () => {
  const repo = newRepo();
  const abs = join(repo, "n.md");
  writeFileSync(abs, "no trailing newline");
  await syncAppend(repo, abs, "x\n\n", "m");
  assert.equal(readFileSync(abs, "utf8"), "no trailing newline\nx\n");
  await syncAppend(repo, abs, "y", "m");
  assert.equal(readFileSync(abs, "utf8"), "no trailing newline\nx\ny\n");
});

test("syncAppend with a remote: pushes and keeps all entries from concurrent calls", async () => {
  const { vault, remote } = newVaultWithRemote();
  const abs = join(vault, "p", "q", "journal", "m.md");
  await Promise.all([1, 2, 3].map((i) => syncAppend(vault, abs, `- r${i}`, `a${i}`)));
  await drainWrites();
  assert.equal(git(["rev-parse", "HEAD"], vault), git(["rev-parse", "main"], remote));
  assert.equal(readFileSync(abs, "utf8").split("\n").filter(Boolean).length, 3);
});

test("syncMove: moves tracked file, commits both paths, creates target dir", async () => {
  const repo = newRepo();
  const from = join(repo, "a", "b", "notes", "x.md");
  await syncWrite(repo, from, "body\n", "add");
  writeFileSync(join(repo, "unrelated.md"), "u\n");
  git(["add", "unrelated.md"], repo); // staged human change must not be swept in
  const to = join(repo, "a", "b", "archive", "notes-x.md");
  const r = await syncMove(repo, from, to, "mv");
  assert.equal(r.to, to);
  assert.equal(r.commitSha, git(["rev-parse", "HEAD"], repo).trim());
  assert.equal(existsSync(from), false);
  assert.equal(readFileSync(to, "utf8"), "body\n");
  assert.deepEqual(git(["show", "--no-renames", "--name-only", "--format=", "HEAD"], repo).split("\n").filter(Boolean).sort(), [
    "a/b/archive/notes-x.md",
    "a/b/notes/x.md",
  ]);
  assert.match(git(["status", "--porcelain"], repo), /unrelated\.md/);
});

test("syncMove: refuses an existing target, missing source; untracked source works", async () => {
  const repo = newRepo();
  const a = join(repo, "a.md");
  const b = join(repo, "b.md");
  await syncWrite(repo, a, "A\n", "a");
  await syncWrite(repo, b, "B\n", "b");
  await assert.rejects(syncMove(repo, a, b, "mv"), MoveTargetExistsError);
  assert.equal(readFileSync(b, "utf8"), "B\n");
  await assert.rejects(syncMove(repo, join(repo, "nope.md"), join(repo, "c.md"), "mv"), MoveSourceMissingError);
  writeFileSync(join(repo, "u.md"), "U\n"); // never committed
  await syncMove(repo, join(repo, "u.md"), join(repo, "d", "u.md"), "mv");
  assert.equal(readFileSync(join(repo, "d", "u.md"), "utf8"), "U\n");
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("syncAppend: text builder runs inside the lock, in file order", async () => {
  const repo = newRepo();
  const abs = join(repo, "j.md");
  let n = 0;
  await Promise.all(Array.from({ length: 8 }, () => syncAppend(repo, abs, () => `- ${n++}`, "a")));
  assert.deepEqual(readFileSync(abs, "utf8").split("\n").filter(Boolean), Array.from({ length: 8 }, (_, i) => `- ${i}`));
});

test("syncAppend: maxChars boundary", async () => {
  const repo = newRepo();
  const abs = join(repo, "m.md");
  await syncAppend(repo, abs, "x".repeat(9), "a", 10); // 9 + \n = 10, allowed
  await assert.rejects(syncAppend(repo, abs, "y", "a", 11 + 1 - 2), NoteTooLargeError);
  assert.equal(readFileSync(abs, "utf8"), "x".repeat(9) + "\n");
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("syncMove: source staged but not in HEAD is moved and committed", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "seed.md"), "s\n");
  git(["add", "."], repo);
  git(["commit", "-m", "seed"], repo);
  writeFileSync(join(repo, "new.md"), "N\n");
  git(["add", "new.md"], repo);
  await syncMove(repo, join(repo, "new.md"), join(repo, "arch", "new.md"), "mv");
  assert.equal(readFileSync(join(repo, "arch", "new.md"), "utf8"), "N\n");
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("syncMove: refuses a committed source with uncommitted edits", async () => {
  const repo = newRepo();
  const a = join(repo, "a.md");
  await syncWrite(repo, a, "A\n", "a");
  writeFileSync(a, "edited\n");
  await assert.rejects(syncMove(repo, a, join(repo, "z", "a.md"), "mv"), MoveSourceDirtyError);
  assert.equal(readFileSync(a, "utf8"), "edited\n");
  assert.equal(existsSync(join(repo, "z", "a.md")), false);
});

test("syncMove: a failed commit (hook) rolls the move back", async () => {
  const repo = newRepo();
  const a = join(repo, "a.md");
  await syncWrite(repo, a, "A\n", "a");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(syncMove(repo, a, join(repo, "z", "a.md"), "mv"));
  assert.equal(readFileSync(a, "utf8"), "A\n");
  assert.equal(existsSync(join(repo, "z", "a.md")), false);
  assert.equal(git(["status", "--porcelain"], repo), "");
});

// ---- write path: commit-landed guard, validation before touching, raw bytes ----

test("lockedWrite: an error reported after the commit landed keeps the write (no silent revert)", async () => {
  const repo = newRepo();
  const abs = join(repo, "j.md");
  await syncAppend(repo, abs, "- one", "a1");
  // `git commit` succeeds but then reports a failure (as a post-commit hook timeout would).
  const cp = require("node:child_process");
  const real = cp.execFile;
  cp.execFile = (file: string, args: string[], opts: unknown, cb: (...a: unknown[]) => void) =>
    real(file, args, opts, (err: unknown, stdout: string, stderr: string) =>
      args[0] === "commit" && !err
        ? cb(Object.assign(new Error("post-commit timed out"), { stdout, stderr }), stdout, stderr)
        : cb(err, stdout, stderr),
    );
  const orig = console.error;
  console.error = () => undefined;
  let r: { commitSha: string | null };
  try {
    r = await syncAppend(repo, abs, "- two", "a2");
  } finally {
    cp.execFile = real;
    console.error = orig;
  }
  const head = git(["rev-parse", "HEAD"], repo).trim();
  assert.equal(r.commitSha, head);
  assert.equal(git(["show", "HEAD:j.md"], repo), "- one\n- two\n");
  assert.equal(readFileSync(abs, "utf8"), "- one\n- two\n", "working tree matches HEAD");
  assert.equal(git(["status", "--porcelain"], repo), "");
  await syncAppend(repo, abs, "- three", "a3");
  assert.equal(git(["show", "HEAD:j.md"], repo), "- one\n- two\n- three\n", "next append does not revert");
});

test("syncAppend: a refused append (size/check) leaves the file and a human's staged state untouched", async () => {
  const repo = newRepo();
  const abs = join(repo, "n.md");
  await syncWrite(repo, abs, "a\n", "a");
  writeFileSync(abs, "a\nstaged by a human\n");
  git(["add", "n.md"], repo);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(abs, old, old);
  const mtime = lstatSync(abs).mtimeMs;
  await assert.rejects(syncAppend(repo, abs, "y".repeat(50), "a", 20), NoteTooLargeError);
  await assert.rejects(
    syncAppend(repo, abs, "z", "a", undefined, () => {
      throw new Error("rule");
    }),
    /rule/,
  );
  assert.equal(lstatSync(abs).mtimeMs, mtime);
  assert.equal(git(["diff", "--cached", "--name-only"], repo).trim(), "n.md", "staged change kept");
  assert.equal(git(["show", ":n.md"], repo), "a\nstaged by a human\n");
});

test("non-UTF-8 note: append is refused and bytes kept; a failed overwrite restores the raw bytes", async () => {
  const repo = newRepo();
  const abs = join(repo, "bin.md");
  const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a, 0xc3, 0x28, 0x0a]);
  writeFileSync(abs, bytes);
  git(["add", "."], repo);
  git(["commit", "-m", "seed"], repo);
  await assert.rejects(syncAppend(repo, abs, "x", "a"), NoteNotUtf8Error);
  assert.ok(readFileSync(abs).equals(bytes));
  // Failed commit (hook) on an overwrite: restore must write the original bytes back.
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(syncWrite(repo, abs, "replaced\n", "w"));
  assert.ok(readFileSync(abs).equals(bytes), "raw bytes restored, no U+FFFD");
  assert.equal(git(["status", "--porcelain"], repo), "");
});
