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
let dropRedundantScopes: typeof import("./token").dropRedundantScopes;

before(async () => {
  ({ parseScopes, resolveScopes, wildcardWarnings, dropRedundantScopes } = await import("./token"));
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

test("dropRedundantScopes drops narrower scopes of the same permission only", () => {
  const { kept, dropped } = dropRedundantScopes(
    parseScopes("*:*:*:read,pro:x:y:read,pro:x:y:write,pro:*:*:write,pro:x:*:write"),
  );
  assert.deepEqual(kept.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`), [
    "*:*:*:read",
    "pro:*:*:write",
  ]);
  assert.equal(dropped.length, 3);
});

test("CLI end-to-end: wildcards need --allow-wildcard, warnings go to stderr before creation, list shows 4-part scopes", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "token.ts"), ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });

  const refused = run("create", "--name", "nope", "--preset", "master");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /WARNING: scope \*:\*:\*:read/);
  assert.match(refused.stderr, /--allow-wildcard/);
  assert.doesNotMatch(refused.stdout, /sb_/);
  assert.doesNotMatch(run("list").stdout, /name=nope/);

  const master = run("create", "--name", "m", "--preset", "master", "--allow-wildcard");
  assert.equal(master.status, 0, master.stderr);
  assert.match(master.stdout, /token: sb_/);
  assert.doesNotMatch(master.stdout, /WARNING/);
  assert.match(master.stderr, /WARNING: scope \*:\*:\*:read/);
  assert.match(master.stderr, /WARNING: scope \*:\*:\*:write/);

  const ro = run("create", "--name", "ro", "--preset", "master-ro", "--allow-wildcard");
  assert.equal(ro.status, 0, ro.stderr);
  assert.match(ro.stderr, /WARNING: scope \*:\*:\*:read/);
  assert.doesNotMatch(ro.stderr, /\*:\*:\*:write/);

  const explicit = run("create", "--name", "ex", "--scope", "pro:x:y:read");
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.doesNotMatch(explicit.stderr, /WARNING/);

  const redundant = run("create", "--name", "red", "--scope", "*:*:*:read,pro:x:y:read", "--allow-wildcard");
  assert.equal(redundant.status, 0, redundant.stderr);
  assert.match(redundant.stderr, /dropped redundant scope pro:x:y:read/);

  const bad = run("create", "--name", "bad", "--scope", "pro:*:y:read");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /trailing levels/);

  const both = run("create", "--name", "b", "--preset", "master", "--scope", "a:b:c:read", "--allow-wildcard");
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /not both/);

  const list = run("list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /name=m .*scopes=\[\*:\*:\*:read, \*:\*:\*:write\]/);
  assert.match(list.stdout, /name=ro .*scopes=\[\*:\*:\*:read\]/);
  assert.match(list.stdout, /name=ex .*scopes=\[pro:x:y:read\]/);
  assert.match(list.stdout, /name=red .*scopes=\[\*:\*:\*:read\]/);
});

test("CLI: --expires-in-days is stored, shown by list, and validated", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "token.ts"), ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });
  const ok = run("create", "--name", "exp", "--scope", "pro:x:y:read", "--expires-in-days", "7");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /expires_at: \d{4}-/);
  const list = run("list").stdout;
  assert.match(list, /name=exp .*expires_at=\d{4}-\d\d-\d\dT\S+  scopes=/);
  assert.match(list, /name=ex .*expires_at=-  scopes=/);
  for (const bad of ["0", "3651", "abc", "1.5"]) {
    const r = run("create", "--name", "badexp", "--scope", "pro:x:y:read", "--expires-in-days", bad);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /1 and 3650/);
  }
});

test("CLI: create and revoke are audited as cli; revoking an unknown id exits 1", async () => {
  const { db } = await import("../db");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "token.ts"), ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });
  const lastRow = (action: string) =>
    db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").get(action) as {
      token_id: string;
      token_name: string;
      result: string;
      detail: string;
    };

  const created = run("create", "--name", "audited", "--scope", "pro:x:y:read");
  assert.equal(created.status, 0, created.stderr);
  const id = /id:\s+(\S+)/.exec(created.stdout)![1];
  const c = lastRow("admin_token_create");
  assert.equal(c.token_id, "cli");
  assert.equal(c.token_name, "cli");
  assert.equal(c.result, "ok");
  assert.equal(c.detail, `${id} audited [pro:x:y:read]`);

  const revoked = run("revoke", "--id", id);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(revoked.stdout, /revoked/);
  const ok = lastRow("admin_token_revoke");
  assert.equal(ok.result, "ok");
  assert.equal(ok.detail, id);

  const again = run("revoke", "--id", id);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /not found \(or already revoked\)/);
  const err = lastRow("admin_token_revoke");
  assert.equal(err.result, "error");
  assert.equal(err.token_name, "cli");
  assert.match(err.detail, /not found or already revoked/);
});
