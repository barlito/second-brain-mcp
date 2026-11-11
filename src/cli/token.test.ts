import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanup, makeTempDb } from "../test-support/fixtures";

// token.ts transitively imports db.ts, which reads DB_PATH at import time —
// point it at a throwaway file before dynamically importing (same pattern
// as auth/tokens.test.ts).
const dbPath = makeTempDb();

let parseScopes: typeof import("./token").parseScopes;
let resolveScopes: typeof import("./token").resolveScopes;
let wildcardWarnings: typeof import("./token").wildcardWarnings;

before(async () => {
  ({ parseScopes, resolveScopes, wildcardWarnings } = await import("./token"));
});

after(() => {
  cleanup();
});

test("parseScopes accepts valid space:project:section:permission scopes", () => {
  const scopes = parseScopes("sp:proj:sect:read,other-sp:other-proj:*:write");
  assert.deepEqual(scopes, [
    { space: "sp", project: "proj", section: "sect", permission: "read" },
    { space: "other-sp", project: "other-proj", section: "*", permission: "write" },
  ]);
});

test("parseScopes only checks shape; values are validated by createToken", () => {
  assert.throws(() => parseScopes("proj:sect:read"), /invalid scope/);
  assert.throws(() => parseScopes("a:b:c:d:e"), /invalid scope/);
  assert.deepEqual(parseScopes("sp:My Project:sect:delete"), [
    { space: "sp", project: "My Project", section: "sect", permission: "delete" },
  ]);
});

test("createToken rejects bad slugs, traversal and permissions parsed from the CLI", async () => {
  const { createToken } = await import("../auth/tokens");
  assert.throws(() => createToken("n", parseScopes("sp:My Project:sect:write")), /invalid project slug/);
  assert.throws(() => createToken("n", parseScopes("sp:proj:Notes!:write")), /invalid section slug/);
  assert.throws(() => createToken("n", parseScopes("../x:proj:sect:read")), /invalid space slug/);
  assert.throws(() => createToken("n", parseScopes("sp:../../etc:sect:read")), /invalid project slug/);
  assert.throws(() => createToken("n", parseScopes("sp:proj:../../etc:read")), /invalid section slug/);
  assert.throws(() => createToken("n", parseScopes("sp:proj:sect:delete")), /invalid permission/);
  assert.throws(() => createToken("n", parseScopes("*:proj:sect:read")), /trailing levels/);
  assert.throws(() => createToken("n", parseScopes("sp:*:sect:read")), /trailing levels/);
});

test("resolveScopes: presets, explicit scopes, and conflicts", () => {
  assert.deepEqual(resolveScopes("master", undefined), [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]);
  assert.deepEqual(resolveScopes("master-ro", undefined), [
    { space: "*", project: "*", section: "*", permission: "read" },
  ]);
  assert.deepEqual(resolveScopes(undefined, "a:b:c:read"), [
    { space: "a", project: "b", section: "c", permission: "read" },
  ]);
  assert.throws(() => resolveScopes("root", undefined), /unknown preset/);
  assert.throws(() => resolveScopes("master", "a:b:c:read"), /not both/);
  assert.throws(() => resolveScopes(undefined, undefined), /--preset or --scope/);
});

test("wildcardWarnings flags only wildcard scopes", () => {
  assert.equal(wildcardWarnings(parseScopes("a:b:c:read")).length, 0);
  const w = wildcardWarnings(parseScopes("*:*:*:write,a:*:*:read,a:b:*:read"));
  assert.equal(w.length, 3);
  assert.match(w[0], /can write EVERY space/);
  assert.match(w[1], /can read every project and section in space "a"/);
  assert.match(w[2], /every section of a\/b/);
});

test("CLI end-to-end: presets create tokens, warn on wildcards, and list shows 4-part scopes", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "token.ts"), ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });

  const master = run("create", "--name", "m", "--preset", "master");
  assert.equal(master.status, 0, master.stderr);
  assert.match(master.stdout, /token: sb_/);
  assert.match(master.stdout, /WARNING: scope \*:\*:\*:read/);
  assert.match(master.stdout, /WARNING: scope \*:\*:\*:write/);

  const ro = run("create", "--name", "ro", "--preset", "master-ro");
  assert.equal(ro.status, 0, ro.stderr);
  assert.match(ro.stdout, /WARNING: scope \*:\*:\*:read/);
  assert.doesNotMatch(ro.stdout, /\*:\*:\*:write/);

  const explicit = run("create", "--name", "ex", "--scope", "pro:x:y:read");
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.doesNotMatch(explicit.stdout, /WARNING/);

  const bad = run("create", "--name", "bad", "--scope", "pro:*:y:read");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /trailing levels/);

  const both = run("create", "--name", "b", "--preset", "master", "--scope", "a:b:c:read");
  assert.notEqual(both.status, 0);

  const list = run("list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /name=m .*scopes=\[\*:\*:\*:read, \*:\*:\*:write\]/);
  assert.match(list.stdout, /name=ro .*scopes=\[\*:\*:\*:read\]/);
  assert.match(list.stdout, /name=ex .*scopes=\[pro:x:y:read\]/);
});
