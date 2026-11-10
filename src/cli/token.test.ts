import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// token.ts transitively imports db.ts, which reads DB_PATH at import time —
// point it at a throwaway file before dynamically importing (same pattern
// as auth/tokens.test.ts).
const tmpDir = mkdtempSync(join(tmpdir(), "second-brain-cli-test-"));
process.env.DB_PATH = join(tmpDir, "test.db");

let parseScopes: typeof import("./token").parseScopes;

before(async () => {
  ({ parseScopes } = await import("./token"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("parseScopes accepts valid project:section:permission scopes", () => {
  const scopes = parseScopes("proj:sect:read,other-proj:other-sect:write");
  assert.deepEqual(scopes, [
    { project: "proj", section: "sect", permission: "read" },
    { project: "other-proj", section: "other-sect", permission: "write" },
  ]);
});

test("parseScopes rejects a project slug that isn't a valid slug", () => {
  assert.throws(() => parseScopes("My Project:sect:write"), /invalid scope/);
});

test("parseScopes rejects a section slug that isn't a valid slug", () => {
  assert.throws(() => parseScopes("proj:Notes!:write"), /invalid scope/);
});

test("parseScopes rejects a path-traversal attempt in project or section", () => {
  assert.throws(() => parseScopes("../../etc:sect:read"), /invalid scope/);
  assert.throws(() => parseScopes("proj:../../etc:read"), /invalid scope/);
});

test("parseScopes rejects malformed entries and bad permissions", () => {
  assert.throws(() => parseScopes("proj:sect"), /invalid scope/);
  assert.throws(() => parseScopes("proj:sect:delete"), /invalid permission/);
});
