import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeBareRemote, makeTempDb, newRepo, tmp } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();

let server: typeof import("./server");
let gitMod: typeof import("./vault/git");

before(async () => {
  server = await import("./server");
  gitMod = await import("./vault/git");
});
after(cleanup);

test("initVault initialises an empty dir without a remote and describes it", async () => {
  const dir = tmp("empty");
  const line = await server.initVault(dir, { VAULT_BRANCH: "main" });
  assert.ok(existsSync(join(dir, ".git")));
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], dir).trim(), "main");
  assert.equal(line, "vault ok: repo=yes remote=no branch=main head=none");
});

test("initVault clones from a remote and never logs credentials", async () => {
  const remote = makeBareRemote();
  const dir = tmp("clone");
  const line = await server.initVault(dir, { VAULT_REMOTE_URL: remote, VAULT_BRANCH: "main" });
  assert.match(line, /remote=yes branch=main/);
  assert.doesNotMatch(line, new RegExp(remote));
});

test("initVault rejects a non-empty non-repo dir", async () => {
  const dir = tmp("full");
  mkdirSync(join(dir, "x"));
  await assert.rejects(server.initVault(dir, {}), /not empty/);
});

test("shutdown drains a pending write, stops sync, closes DB, exits 0; second call exits 1", async () => {
  const vault = newRepo();
  const app = await listen(server.createApp({ vaultRoot: vault }));
  const events: string[] = [];
  const exits: number[] = [];
  const shutdown = server.createShutdown({
    server: app.server,
    stopSync: () => events.push("stopSync"),
    closeDb: () => events.push("closeDb"),
    exit: (c) => exits.push(c),
  });
  mkdirSync(join(vault, "p"), { recursive: true });
  const pending = gitMod.syncWrite(vault, join(vault, "p", "n.md"), "n\n", "pending write");
  await shutdown("SIGTERM");
  await pending;
  assert.match(git(["log", "--oneline", "-1"], vault), /pending write/);
  assert.deepEqual(events, ["stopSync", "closeDb"]);
  assert.deepEqual(exits, [0]);
  assert.equal(app.server.listening, false);

  await shutdown("SIGINT");
  assert.deepEqual(exits, [0, 1]);
});

test("shutdown gives up on a stuck drain after the cap", async () => {
  const vault = newRepo();
  const app = await listen(server.createApp({ vaultRoot: vault }));
  const exits: number[] = [];
  const shutdown = server.createShutdown({
    server: app.server,
    closeDb: () => undefined,
    drain: () => new Promise(() => undefined),
    drainTimeoutMs: 50,
    exit: (c) => exits.push(c),
  });
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
});
