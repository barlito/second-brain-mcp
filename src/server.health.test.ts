import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, newRepo, tmp } from "./test-support/fixtures";
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
    sync: { hasRemote: false, branch: null, unpushed: false, lastPushOk: null, conflicts: 0 },
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
