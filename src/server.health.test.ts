import "./server.helpers.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDirs, git, listen, newRepo, tmp } from "./server.helpers.test";

let createApp: typeof import("./server").createApp;
let syncWrite: typeof import("./vault/git").syncWrite;
let drainWrites: typeof import("./vault/git").drainWrites;

before(async () => {
  ({ createApp } = await import("./server"));
  ({ syncWrite, drainWrites } = await import("./vault/git"));
});
after(cleanupDirs);

async function health(vault: string) {
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const res = await fetch(`${app.baseUrl}/health`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } finally {
    await app.close();
  }
}

test("healthy vault: 200 ok, no secrets", async () => {
  const { status, body } = await health(newRepo());
  assert.equal(status, 200);
  assert.deepEqual(body, {
    status: "ok",
    db: "ok",
    vault: "ok",
    sync: { hasRemote: false, unpushed: false, lastPushOk: null, conflicts: 0 },
  });
});

test("vault that is not a git repo: 503", async () => {
  const { status, body } = await health(tmp("plain"));
  assert.equal(status, 503);
  assert.equal(body.status, "error");
  assert.equal(body.vault, "error");
  assert.equal(body.db, "ok");
});

test("failed push: 200 degraded", async () => {
  const vault = newRepo();
  git(["remote", "add", "origin", join(tmp("gone"), "missing.git")], vault);
  mkdirSync(join(vault, "p"), { recursive: true });
  await syncWrite(vault, join(vault, "p", "a.md"), "a\n", "a");
  await drainWrites();
  const { status, body } = await health(vault);
  assert.equal(status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.sync.hasRemote, true);
  assert.equal(body.sync.lastPushOk, false);
  assert.doesNotMatch(JSON.stringify(body), /missing\.git/);
});
