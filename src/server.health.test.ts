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
    for (let i = 0; i < 200 && !lastAudit(db, "action = 'sync_conflict'"); i++) await sleep(25);
  } finally {
    stop();
    await drainWrites();
    console.error = orig;
    gitMod.setSyncEventHandler(null);
  }
  try {
  const backup = git(["branch", "--list", "conflict/*", "--format=%(refname:short)"], vault).trim();
  assert.match(backup, /^conflict\//);
  const row = lastAudit(db, "action = 'sync_conflict'");
  assert.equal(row.result, "error");
  assert.equal(row.token_name, "git-sync");
  const detail = JSON.parse(row.detail!);
  assert.equal(detail.origin, "periodic");
  assert.equal(detail.branch, backup);
  assert.deepEqual(detail.tokens, ["alice"]);
  assert.deepEqual(detail.paths, ["note.md"]);
  assert.equal(detail.commits, 1);
  assert.equal(detail.first, localSha.slice(0, 12));
  assert.equal(detail.last, localSha.slice(0, 12));

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
  } finally {
    gitMod.setConflictCacheTtlMs(30_000);
  }
});

// ---- conflict visibility helpers / tests ----

const cp = require("node:child_process");

// Vault with a remote, unpushed local commits (given subjects, newest last; the
// first also edits note.md) and a conflicting remote edit.
async function conflictedVault(subjects: string[]): Promise<{ vault: string; remote: string }> {
  const { vault, remote } = makeTempVault({ remote: true }) as { vault: string; remote: string };
  await syncWrite(vault, join(vault, "note.md"), "base\n", "base");
  await drainWrites();
  const other = cloneRepo(remote, "other");
  writeFileSync(join(vault, "note.md"), "local\n");
  git(["commit", "-am", subjects[0]], vault);
  for (const subj of subjects.slice(1)) git(["commit", "--allow-empty", "-m", subj], vault);
  writeFileSync(join(other, "note.md"), "remote\n");
  git(["commit", "-am", "remote edit"], other);
  git(["push"], other);
  return { vault, remote };
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => undefined;
  return fn().finally(() => {
    console.error = orig;
  });
}

test("syncConflictDetail: compact JSON, important fields first, always within the audit cap", async () => {
  const { syncConflictDetail } = await import("./server");
  const { MAX_FIELD_LEN } = await import("./audit");
  const sha = "a".repeat(40);
  const d = syncConflictDetail({
    vaultRoot: "/v",
    origin: "periodic",
    backupBranch: "conflict/20260101T000000Z",
    ok: true,
    commits: Array.from({ length: 9 }, () => sha),
    tokens: Array.from({ length: 12 }, (_, i) => `token-name-${i}`.padEnd(40, "x")),
    paths: Array.from({ length: 9 }, (_, i) => `p, with "odd" chars/${i}/${"d".repeat(100)}.md`),
  });
  assert.ok(d.length <= MAX_FIELD_LEN, `${d.length}`);
  const j = JSON.parse(d);
  assert.deepEqual(Object.keys(j).slice(0, 3), ["origin", "branch", "tokens"]);
  assert.equal(j.commits, 9);
  assert.ok(j.more > 0);
  assert.ok(d.endsWith(`"more":${j.more}}`));
  const small = JSON.parse(
    syncConflictDetail({ vaultRoot: "/v", origin: "push-retry", backupBranch: "b", ok: false, error: "boom", commits: [], tokens: [], paths: [] }),
  );
  assert.deepEqual(small, { origin: "push-retry", branch: "b", ok: false, error: "boom", tokens: [], paths: [], commits: 0 });
});

test("auditSyncConflict: write-path origin writes no row; background origins do", async () => {
  const { auditSyncConflict } = await import("./server");
  const { db } = await import("./db");
  const count = (): number => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_conflict'").get() as { n: number }).n;
  const base = { vaultRoot: "/v", backupBranch: "conflict/x", ok: true, commits: ["a".repeat(40)], tokens: [], paths: [] };
  const n0 = count();
  auditSyncConflict({ ...base, origin: "write" });
  assert.equal(count(), n0);
  auditSyncConflict({ ...base, origin: "push-retry" });
  auditSyncConflict({ ...base, origin: "periodic" });
  assert.equal(count(), n0 + 2);
});

test("write-path conflict: event has origin=write, only exact server subjects attribute tokens, emitted before the backup push", async () => {
  const gitMod = await import("./vault/git");
  const { vault, remote } = await conflictedVault([
    "kb_write: sp/p/s/note via alice",
    "kb_append: sp/p/s/note via bob.smith",
    "kb_write: sp/p/s/note via two words",
    "chore: sp/p/s/note via mallory",
    "kb_write: a b via eve",
    "kb_write: sp/p/s/note via carol; kb_write: x via dave",
  ]);
  const events: import("./vault/git").SyncConflictEvent[] = [];
  let remoteHadBackup: string | null = null;
  gitMod.setSyncEventHandler((e) => {
    remoteHadBackup = git(["branch", "--list", "conflict/*"], remote).trim();
    events.push(e);
  });
  try {
    await quiet(async () => {
      await assert.rejects(() => syncWrite(vault, join(vault, "other.md"), "x\n", "x"), { name: "SyncConflictError" });
    });
    await sleep(20);
  } finally {
    gitMod.setSyncEventHandler(null);
    await drainWrites();
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, "write");
  assert.equal(events[0].ok, true);
  assert.equal(events[0].commits.length, 6);
  assert.deepEqual(events[0].tokens.sort(), ["alice", "bob.smith"]);
  assert.equal(remoteHadBackup, "", "event must precede the network push of the backup branch");
  assert.deepEqual(gitMod.getSyncStatus(vault).conflictBranches, [events[0].backupBranch]);
});

test("sync handler that throws or rejects never reaches the git path or the process", async () => {
  const gitMod = await import("./vault/git");
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown): void => void unhandled.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const handler of [
      async () => {
        throw new Error("async boom");
      },
      () => {
        throw new Error("sync boom");
      },
    ]) {
      const { vault } = await conflictedVault(["kb_write: sp/p/s/note via alice"]);
      gitMod.setSyncEventHandler(handler);
      try {
        await quiet(async () => {
          await assert.rejects(() => syncWrite(vault, join(vault, "other.md"), "x\n", "x"), { name: "SyncConflictError" });
        });
        await sleep(30);
      } finally {
        gitMod.setSyncEventHandler(null);
        await drainWrites();
      }
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("refresh race: a branch added while a refresh is in flight survives it", async () => {
  const gitMod = await import("./vault/git");
  const { vault } = await conflictedVault(["kb_write: sp/p/s/note via alice"]);
  const realExecFile = cp.execFile;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  cp.execFile = (file: string, args: string[], opts: unknown, cb: (...a: unknown[]) => void) => {
    if (args.includes("for-each-ref")) {
      started = true;
      // Real result is computed now (empty); delivery is held back.
      return realExecFile(file, args, opts, (...r: unknown[]) => void gate.then(() => cb(...r)));
    }
    return realExecFile(file, args, opts, cb);
  };
  gitMod.setConflictCacheTtlMs(0);
  try {
    const refresh = gitMod.refreshConflictBranches(vault);
    for (let i = 0; i < 100 && !started; i++) await sleep(10);
    assert.ok(started);
    await quiet(async () => {
      await assert.rejects(() => syncWrite(vault, join(vault, "other.md"), "x\n", "x"), { name: "SyncConflictError" });
    });
    release();
    await refresh;
    const backup = git(["branch", "--list", "conflict/*", "--format=%(refname:short)"], vault).trim();
    assert.match(backup, /^conflict\//);
    assert.deepEqual(gitMod.getSyncStatus(vault).conflictBranches, [backup]);
    // The recovery also invalidated the cache: the next call re-lists.
    gitMod.setConflictCacheTtlMs(30_000);
    git(["branch", "-D", backup], vault);
    await gitMod.refreshConflictBranches(vault);
    assert.deepEqual(gitMod.getSyncStatus(vault).conflictBranches, []);
  } finally {
    release();
    cp.execFile = realExecFile;
    gitMod.setConflictCacheTtlMs(30_000);
    await drainWrites();
  }
});

test("refresh is de-duplicated: concurrent /health/details spawn one for-each-ref; a failing refresh is cached too", async () => {
  const gitMod = await import("./vault/git");
  const realExecFile = cp.execFile;
  let spawns = 0;
  cp.execFile = (file: string, args: string[], ...rest: unknown[]) => {
    if (args.includes("for-each-ref")) spawns++;
    return realExecFile(file, args, ...rest);
  };
  try {
    const vault = newRepo("dedupe");
    const app = await listen(createApp({ vaultRoot: vault }));
    try {
      const rs = await Promise.all(
        Array.from({ length: 8 }, () => fetch(`${app.baseUrl}/health/details`, { headers: { Authorization: `Bearer ${token}` } })),
      );
      for (const r of rs) assert.equal(r.status, 200);
      assert.equal(spawns, 1);
    } finally {
      await app.close();
    }
    // Failing git (not a repo): one spawn, then served from the cache.
    spawns = 0;
    const plain = tmp("plain-refresh");
    await Promise.all([gitMod.refreshConflictBranches(plain), gitMod.refreshConflictBranches(plain)]);
    await gitMod.refreshConflictBranches(plain);
    assert.equal(spawns, 1);
  } finally {
    cp.execFile = realExecFile;
  }
});
