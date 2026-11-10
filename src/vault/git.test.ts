import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasRemote, pullRebase, writeNoteAtomic, commitFile, queuePush, syncWrite } from "./git";

let vaultRoot: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultRoot, encoding: "utf8" });
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
  assert.doesNotThrow(() => pullRebase(vaultRoot));
});

test("queuePush is a no-op and does not throw when there's no remote", () => {
  assert.doesNotThrow(() => queuePush(vaultRoot));
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
  const relativePath = "sync-note.md";

  const first = await syncWrite(vaultRoot, relativePath, "v1\n", "sync v1");
  const second = await syncWrite(vaultRoot, relativePath, "v2\n", "sync v2");

  assert.notEqual(first.commitSha, second.commitSha);
  assert.equal(readFileSync(join(vaultRoot, relativePath), "utf8"), "v2\n");

  const log = git(["log", "--oneline"]);
  assert.match(log, /sync v1/);
  assert.match(log, /sync v2/);
});

// No real remote exists in this environment to exercise the push-success path
// against (local dev vault deliberately has none). queuePush's no-remote
// no-op branch is covered above; the retry/backoff logic is written
// defensively but not exercised end-to-end here.
