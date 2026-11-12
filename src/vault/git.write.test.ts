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
  commitFile,
  drainWrites,
  redact,
  VaultBusyError,
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
import { cleanup, git, newRepo, tmp } from "../test-support/fixtures";
import { newVaultWithRemote } from "../test-support/git-helpers";

after(cleanup);

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

test("identical re-write succeeds even with untracked files present", async () => {
  const repo = newRepo();
  const { commitSha } = await syncWrite(repo, join(repo, "a.md"), "a\n", "a");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  const again = await syncWrite(repo, join(repo, "a.md"), "a\n", "a again");
  assert.ok(commitSha);
  assert.equal(again.commitSha, null); // nothing committed: HEAD is not reported as ours
  assert.equal(git(["rev-list", "--count", "HEAD"], repo).trim(), "1");
});

test("write queue is bounded: excess writes are refused as busy, the rest land", async () => {
  const repo = newRepo();
  process.env.VAULT_WRITE_QUEUE_MAX = "3";
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => syncWrite(repo, join(repo, `q${i}.md`), `${i}\n`, `q${i}`)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const busy = results.filter((r) => r.status === "rejected" && r.reason instanceof VaultBusyError);
    assert.equal(ok.length, 3);
    assert.equal(busy.length, 5);
    // Slots free up once the queue drains.
    await syncWrite(repo, join(repo, "after.md"), "a\n", "after");
  } finally {
    delete process.env.VAULT_WRITE_QUEUE_MAX;
  }
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
