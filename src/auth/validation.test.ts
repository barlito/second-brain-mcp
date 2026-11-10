import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "second-brain-validation-test-"));
process.env.DB_PATH = join(tmpDir, "test.db");

let t: typeof import("./tokens");
let db: typeof import("../db").db;
const ok = [{ project: "proj", section: "sect", permission: "read" as const }];

before(async () => {
  t = await import("./tokens");
  ({ db } = await import("../db"));
});

test("name is trimmed and length/control chars are validated", () => {
  const c = t.createToken("  padded  ", ok);
  assert.equal(c.name, "padded");
  assert.throws(() => t.createToken("   ", ok), t.TokenValidationError);
  assert.throws(() => t.createToken("x".repeat(65), ok), /1-64/);
  assert.throws(() => t.createToken("a\nb", ok), /control/);
  assert.throws(() => t.createToken("a\u0000b", ok), /control/);
  assert.throws(() => t.createToken(undefined as unknown as string, ok), t.TokenValidationError);
});

test("scopes are validated", () => {
  assert.throws(() => t.createToken("n", []), /at least one scope/);
  assert.throws(
    () => t.createToken("n", [{ project: "Bad Slug", section: "s", permission: "read" }]),
    /invalid project slug/,
  );
  assert.throws(
    () => t.createToken("n", [{ project: "p", section: "../x", permission: "read" }]),
    /invalid section slug/,
  );
  assert.throws(
    () => t.createToken("n", [{ project: "p", section: "s", permission: "admin" as never }]),
    /invalid permission/,
  );
});

test("duplicate scopes are de-duplicated", () => {
  const c = t.createToken("dup", [...ok, ...ok, { project: "proj", section: "sect", permission: "write" }]);
  assert.equal(t.verifyToken(c.token)?.scopes.length, 2);
});

test("a rejected token leaves no rows behind", () => {
  const before = t.listTokens().length;
  assert.throws(() => t.createToken("n", [{ project: "BAD", section: "s", permission: "read" }]));
  assert.equal(t.listTokens().length, before);
});

test("verifyToken throttles last_used_at writes", () => {
  const c = t.createToken("throttle", ok);
  const get = () =>
    (db.prepare("SELECT last_used_at FROM tokens WHERE id = ?").get(c.id) as { last_used_at: string | null })
      .last_used_at;
  assert.equal(get(), null);
  t.verifyToken(c.token);
  const first = get();
  assert.ok(first);
  t.verifyToken(c.token);
  assert.equal(get(), first);
  const stale = new Date(Date.now() - 120_000).toISOString();
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(stale, c.id);
  t.verifyToken(c.token);
  assert.notEqual(get(), stale);
});
