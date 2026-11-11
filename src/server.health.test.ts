import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, cloneRepo, git, makeTempDb, makeTempVault, newRepo, sleep, tmp } from "./test-support/fixtures";
import { lastAudit } from "./test-support/server";
import { listen } from "./test-support/server";

makeTempDb();

let createApp: typeof import("./server").createApp;
let syncWrite: typeof import("./vault/git").syncWrite;
let drainWrites: typeof import("./vault/git").drainWrites;
let token: string;

before(async () => {
  ({ createApp } = await import("./server"));
  ({ syncWrite, drainWrites } = await import("./vault/git"));
  const { createToken } = await import("./auth/tokens");
  token = createToken("health-token", [{ space: "sp", project: "p", section: "s", permission: "read" }]).token;
});
after(cleanup);

async function health(vault: string, details = false) {
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const res = await fetch(`${app.baseUrl}/health${details ? "/details" : ""}`, {
      headers: details ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } finally {
    await app.close();
  }
}

test("public /health: only {status}", async () => {
  const { status, body } = await health(newRepo());
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("public /health: 503 when the vault is not a git repo", async () => {
  const { status, body } = await health(tmp("plain"));
  assert.equal(status, 503);
  assert.deepEqual(body, { status: "error" });
});

test("/health/details requires a token", async () => {
  const app = await listen(createApp({ vaultRoot: newRepo() }));
  try {
    assert.equal((await fetch(`${app.baseUrl}/health/details`)).status, 401);
  } finally {
    await app.close();
  }
});

test("/health/details: full view for a valid token", async () => {
  const { status, body } = await health(newRepo(), true);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    status: "ok",
    db: "ok",
    vault: "ok",
    sync: { hasRemote: false, branch: null, unpushed: false, lastPushOk: null, conflicts: 0, conflictBranches: [] },
  });
});

test("/health/details: non-git vault is 503 with details", async () => {
  const { status, body } = await health(tmp("plain2"), true);
  assert.equal(status, 503);
  assert.equal(body.vault, "error");
});

test("failed push: 200 degraded", async () => {
  const vault = newRepo();
  git(["remote", "add", "origin", join(tmp("gone"), "missing.git")], vault);
  mkdirSync(join(vault, "p"), { recursive: true });
  await syncWrite(vault, join(vault, "p", "a.md"), "a\n", "a");
  await drainWrites();
  const pub = await health(vault);
  assert.deepEqual(pub, { status: 200, body: { status: "ok" } });
  const { status, body } = await health(vault, true);
  assert.equal(status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.sync.hasRemote, true);
  assert.equal(body.sync.lastPushOk, false);
  assert.doesNotMatch(JSON.stringify(body), /missing\.git/);
});

test("async periodic-sync conflict: audited, degraded until the conflict branch is deleted; /health never spawns git", async () => {
  const gitMod = await import("./vault/git");
  const { auditSyncConflict } = await import("./server");
  const { db } = await import("./db");
  const { vault, remote } = makeTempVault({ remote: true }) as { vault: string; remote: string };
  await syncWrite(vault, join(vault, "note.md"), "base\n", "base");
  await drainWrites();
  const other = cloneRepo(remote, "other");

  // An acknowledged-but-unpushed write by token "alice", then a conflicting remote edit.
  writeFileSync(join(vault, "note.md"), "local\n");
  git(["commit", "-am", "kb_write: sp/p/s/note via alice"], vault);
  const localSha = git(["rev-parse", "HEAD"], vault).trim();
  writeFileSync(join(other, "note.md"), "remote\n");
  git(["commit", "-am", "remote edit"], other);
  git(["push"], other);

  gitMod.setSyncEventHandler(auditSyncConflict);
  gitMod.setConflictCacheTtlMs(0);
  const orig = console.error;
  console.error = () => undefined;
  const stop = gitMod.startPeriodicSync(vault, 30);
  try {
    for (let i = 0; i < 200 && !git(["branch", "--list", "conflict/*"], vault).trim(); i++) await sleep(25);
  } finally {
    stop();
    await drainWrites();
    console.error = orig;
    gitMod.setSyncEventHandler(null);
  }
  const backup = git(["branch", "--list", "conflict/*", "--format=%(refname:short)"], vault).trim();
  assert.match(backup, /^conflict\//);
  const row = lastAudit(db, "action = 'sync_conflict'");
  assert.equal(row.result, "error");
  assert.equal(row.token_name, "git-sync");
  assert.ok(row.detail!.includes(`branch=${backup}`));
  assert.ok(row.detail!.includes(localSha.slice(0, 12)));
  assert.ok(row.detail!.includes("tokens=alice"));
  assert.ok(row.detail!.includes("note.md"));

  const d1 = await health(vault, true);
  assert.equal(d1.body.status, "degraded");
  assert.deepEqual(d1.body.sync.conflictBranches, [backup]);

  // /health must not spawn git: count child-process spawns.
  const cp = require("node:child_process");
  const realExecFile = cp.execFile;
  let calls = 0;
  cp.execFile = (...a: unknown[]) => {
    calls++;
    return realExecFile(...a);
  };
  try {
    const app = await listen(createApp({ vaultRoot: vault }));
    try {
      for (let i = 0; i < 5; i++) assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
      assert.equal(calls, 0);
      // Sanity: the spy sees git spawned by /health/details.
      await fetch(`${app.baseUrl}/health/details`, { headers: { Authorization: `Bearer ${token}` } });
      assert.ok(calls > 0);
    } finally {
      await app.close();
    }
  } finally {
    cp.execFile = realExecFile;
  }

  // The user deletes the backup branch: next refresh returns to ok.
  git(["branch", "-D", backup], vault);
  const d2 = await health(vault, true);
  assert.equal(d2.body.status, "ok");
  assert.deepEqual(d2.body.sync.conflictBranches, []);
  gitMod.setConflictCacheTtlMs(30_000);
});
