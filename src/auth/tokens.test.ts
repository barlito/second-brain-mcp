import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb } from "../test-support/fixtures";

// DB_PATH must be set before db.ts is loaded (it reads the env var at import time),
// so delay the import to a `before` hook (top-level await isn't available under
// the project's CJS module target) and point at a throwaway temp file instead
// of the real /data/acl.db.
makeTempDb();

let createToken: typeof import("./tokens").createToken;
let verifyToken: typeof import("./tokens").verifyToken;
let revokeToken: typeof import("./tokens").revokeToken;
let listTokens: typeof import("./tokens").listTokens;

before(async () => {
  ({ createToken, verifyToken, revokeToken, listTokens } = await import("./tokens"));
});

test("createToken returns a usable plaintext token that verifyToken accepts with the right scopes", () => {
  const created = createToken("test-token", [
    { project: "proj", section: "sect", permission: "read" },
  ]);

  const verified = verifyToken(created.token);

  assert.ok(verified);
  assert.equal(verified?.tokenId, created.id);
  assert.equal(verified?.name, "test-token");
  assert.deepEqual(verified?.scopes, [
    { project: "proj", section: "sect", permission: "read" },
  ]);
});

test("verifyToken returns null for a garbage/unknown token", () => {
  assert.equal(verifyToken("sb_this_is_not_a_real_token"), null);
  assert.equal(verifyToken("garbage"), null);
});

test("revokeToken makes a previously-valid token fail verifyToken afterward", () => {
  const created = createToken("revoke-me", [
    { project: "proj", section: "sect", permission: "write" },
  ]);

  assert.ok(verifyToken(created.token));

  const revoked = revokeToken(created.id);
  assert.equal(revoked, true);
  assert.equal(verifyToken(created.token), null);

  // revoking again (already revoked, or unknown id) reports no row updated
  assert.equal(revokeToken(created.id), false);
  assert.equal(revokeToken("00000000-0000-0000-0000-000000000000"), false);
});

test("listTokens never exposes token_hash or plaintext", () => {
  const created = createToken("list-me", [
    { project: "proj", section: "sect", permission: "read" },
  ]);

  const tokens = listTokens();
  const entry = tokens.find((t) => t.id === created.id);

  assert.ok(entry);
  assert.ok(!("token_hash" in (entry as unknown as Record<string, unknown>)));
  assert.ok(!("token" in (entry as unknown as Record<string, unknown>)));
  assert.deepEqual(entry?.scopes, [
    { project: "proj", section: "sect", permission: "read" },
  ]);

  for (const t of tokens) {
    assert.ok(!JSON.stringify(t).includes(created.token));
  }
});

after(cleanup);
