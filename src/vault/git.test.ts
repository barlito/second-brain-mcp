import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasRemote,
  pullRebase,
  writeNoteAtomic,
  commitFile,
  queuePush,
  syncWrite,
  PushFn,
} from "./git";

let vaultRoot: string;

function git(args: string[], cwd: string = vaultRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

before(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "second-brain-git-test-"));
  git(["init"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "user.email", "test@example.com"]);
});

after(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

test("hasRemote returns false on a freshly-init'd repo with no remote", () => {
  assert.equal(hasRemote(vaultRoot), false);
});

test("pullRebase is a no-op and does not throw when there's no remote", () => {
  assert.doesNotThrow(() => pullRebase(vaultRoot, hasRemote(vaultRoot)));
});

test("queuePush resolves without throwing when there's no remote", async () => {
  await assert.doesNotReject(queuePush(vaultRoot, hasRemote(vaultRoot)));
});

test("writeNoteAtomic + commitFile produces a real commit with the expected content", () => {
  const relativePath = "note.md";
  const absolutePath = join(vaultRoot, relativePath);

  writeNoteAtomic(absolutePath, "# hello\n");
  const sha = commitFile(vaultRoot, relativePath, "add note");

  assert.equal(readFileSync(absolutePath, "utf8"), "# hello\n");
  assert.match(sha, /^[0-9a-f]{40}$/);

  const log = git(["log", "--oneline", "-1"]);
  assert.match(log, /add note/);

  const headSha = git(["rev-parse", "HEAD"]).trim();
  assert.equal(sha, headSha);
});

test("commitFile returns current HEAD sha gracefully when there's nothing to commit", () => {
  const relativePath = "note.md";
  const absolutePath = join(vaultRoot, relativePath);

  const beforeSha = git(["rev-parse", "HEAD"]).trim();

  // Rewriting identical content: `git add` stages nothing, commit would fail.
  writeNoteAtomic(absolutePath, "# hello\n");
  const sha = commitFile(vaultRoot, relativePath, "no-op commit");

  assert.equal(sha, beforeSha);
});

test("syncWrite called twice sequentially produces two commits", async () => {
  const absolutePath = join(vaultRoot, "sync-note.md");

  const first = await syncWrite(vaultRoot, absolutePath, "v1\n", "sync v1");
  const second = await syncWrite(vaultRoot, absolutePath, "v2\n", "sync v2");

  assert.notEqual(first.commitSha, second.commitSha);
  assert.equal(readFileSync(absolutePath, "utf8"), "v2\n");

  const log = git(["log", "--oneline"]);
  assert.match(log, /sync v1/);
  assert.match(log, /sync v2/);
});

// No real remote exists in this environment to exercise the push-success path
// against (local dev vault deliberately has none). queuePush's no-remote
// no-op branch is covered above; the retry/backoff logic is written
// defensively but not exercised end-to-end here.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("second syncWrite's locked work does not start until the first call's push has settled", async () => {
  // A real (local, file-based) remote so hasRemote() is true and pullRebase
  // performs a genuine (trivially no-op, since it's in sync) `git pull
  // --rebase` — only the push itself is faked, since there's nothing to push
  // to in this environment and we want to control its timing precisely.
  const raceRoot = mkdtempSync(join(tmpdir(), "second-brain-git-race-test-"));
  const bareRemote = mkdtempSync(join(tmpdir(), "second-brain-git-race-remote-"));

  git(["init", "-b", "main"], raceRoot);
  git(["config", "user.name", "Test User"], raceRoot);
  git(["config", "user.email", "test@example.com"], raceRoot);
  writeFileSync(join(raceRoot, "seed.md"), "seed\n");
  git(["add", "seed.md"], raceRoot);
  git(["commit", "-m", "seed"], raceRoot);

  git(["init", "--bare"], bareRemote);
  git(["remote", "add", "origin", bareRemote], raceRoot);
  git(["push", "-u", "origin", "main"], raceRoot);

  try {
    const events: string[] = [];
    let resolveFirstPush: () => void = () => {};
    const firstPushGate = new Promise<void>((resolve) => {
      resolveFirstPush = resolve;
    });

    let pushCallCount = 0;
    const fakePush: PushFn = async () => {
      pushCallCount += 1;
      const n = pushCallCount;
      events.push(`push${n}-start`);
      if (n === 1) {
        await firstPushGate;
      }
      events.push(`push${n}-end`);
    };

    const absolutePath = join(raceRoot, "race-note.md");

    const firstDone = syncWrite(raceRoot, absolutePath, "v1\n", "sync v1", fakePush);
    const first = await firstDone;

    assert.match(first.commitSha, /^[0-9a-f]{40}$/);
    // The caller got its result back without waiting for the push to settle.
    assert.deepEqual(events, ["push1-start"]);

    let secondStarted = false;
    const secondDone = syncWrite(raceRoot, absolutePath, "v2\n", "sync v2", fakePush).then(
      (r) => {
        secondStarted = true;
        return r;
      },
    );

    // Give the event loop plenty of room to (incorrectly) start the second
    // call's locked work while the first push is still pending.
    await sleep(50);
    assert.equal(secondStarted, false);
    assert.ok(!events.includes("push2-start"));

    resolveFirstPush();
    const second = await secondDone;

    assert.equal(secondStarted, true);
    assert.notEqual(first.commitSha, second.commitSha);
    assert.deepEqual(events, ["push1-start", "push1-end", "push2-start", "push2-end"]);
  } finally {
    rmSync(raceRoot, { recursive: true, force: true });
    rmSync(bareRemote, { recursive: true, force: true });
  }
});
