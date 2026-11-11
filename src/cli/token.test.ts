import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb } from "../test-support/fixtures";

// token.ts transitively imports db.ts, which reads DB_PATH at import time —
// point it at a throwaway file before dynamically importing (same pattern
// as auth/tokens.test.ts).
makeTempDb();

let parseScopes: typeof import("./token").parseScopes;

before(async () => {
  ({ parseScopes } = await import("./token"));
});

after(() => {
  cleanup();
});

test("parseScopes accepts valid project:section:permission scopes", () => {
  const scopes = parseScopes("proj:sect:read,other-proj:other-sect:write");
  assert.deepEqual(scopes, [
    { project: "proj", section: "sect", permission: "read" },
    { project: "other-proj", section: "other-sect", permission: "write" },
  ]);
});

test("parseScopes only checks shape; values are validated by createToken", () => {
  assert.throws(() => parseScopes("proj:sect"), /invalid scope/);
  assert.throws(() => parseScopes("a:b:c:d"), /invalid scope/);
  assert.deepEqual(parseScopes("My Project:sect:delete"), [
    { project: "My Project", section: "sect", permission: "delete" },
  ]);
});

test("createToken rejects bad slugs, traversal and permissions parsed from the CLI", async () => {
  const { createToken } = await import("../auth/tokens");
  assert.throws(() => createToken("n", parseScopes("My Project:sect:write")), /invalid project slug/);
  assert.throws(() => createToken("n", parseScopes("proj:Notes!:write")), /invalid section slug/);
  assert.throws(() => createToken("n", parseScopes("../../etc:sect:read")), /invalid project slug/);
  assert.throws(() => createToken("n", parseScopes("proj:../../etc:read")), /invalid section slug/);
  assert.throws(() => createToken("n", parseScopes("proj:sect:delete")), /invalid permission/);
});
