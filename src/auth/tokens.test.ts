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
    { space: "sp", project: "proj", section: "sect", permission: "read" },
  ]);

  const verified = verifyToken(created.token);

  assert.ok(verified);
  assert.equal(verified?.tokenId, created.id);
  assert.equal(verified?.name, "test-token");
  assert.deepEqual(verified?.scopes, [
    { space: "sp", project: "proj", section: "sect", permission: "read" },
  ]);
});

test("verifyToken returns null for a garbage/unknown token", () => {
  assert.equal(verifyToken("sb_this_is_not_a_real_token"), null);
  assert.equal(verifyToken("garbage"), null);
});

test("revokeToken makes a previously-valid token fail verifyToken afterward", () => {
  const created = createToken("revoke-me", [
    { space: "sp", project: "proj", section: "sect", permission: "write" },
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
    { space: "sp", project: "proj", section: "sect", permission: "read" },
  ]);

  const tokens = listTokens();
  const entry = tokens.find((t) => t.id === created.id);

  assert.ok(entry);
  assert.ok(!("token_hash" in (entry as unknown as Record<string, unknown>)));
  assert.ok(!("token" in (entry as unknown as Record<string, unknown>)));
  assert.deepEqual(entry?.scopes, [
    { space: "sp", project: "proj", section: "sect", permission: "read" },
  ]);

  for (const t of tokens) {
    assert.ok(!JSON.stringify(t).includes(created.token));
  }
});

const sc = [{ space: "sp", project: "proj", section: "sect", permission: "read" as const }];

test("expiry: not-yet-expired accepted, expired rejected like revoked, list shows both", async () => {
  const { db } = await import("../db");
  const never = createToken("never", sc);
  const soon = createToken("soon", sc, { expiresInDays: 30 });
  const abs = createToken("abs", sc, { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(never.expires_at, null);
  assert.ok(Date.parse(soon.expires_at!) > Date.now() + 29 * 86_400_000);
  assert.ok(verifyToken(never.token));
  assert.ok(verifyToken(soon.token));
  assert.ok(verifyToken(abs.token));

  db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), soon.id);
  assert.equal(verifyToken(soon.token), null);
  assert.ok(verifyToken(abs.token));

  const list = listTokens();
  const byId = (id: string) => list.find((t) => t.id === id)!;
  assert.equal(byId(never.id).expires_at, null);
  assert.equal(byId(never.id).expired, false);
  assert.equal(byId(soon.id).expired, true);
  assert.equal(byId(abs.id).expired, false);
  assert.equal(byId(abs.id).expires_at, abs.expires_at);
});

test("expiry: invalid options are rejected", () => {
  assert.throws(() => createToken("x", sc, { expiresInDays: 0 }), /between 1 and 3650/);
  assert.throws(() => createToken("x", sc, { expiresInDays: 3651 }), /between 1 and 3650/);
  assert.throws(() => createToken("x", sc, { expiresInDays: 1.5 }), /between 1 and 3650/);
  assert.throws(() => createToken("x", sc, { expiresAt: "nonsense" }), /explicit Z or offset/);
  assert.throws(() => createToken("x", sc, { expiresAt: "2000-01-01T00:00:00Z" }), /in the future/);
  assert.throws(() => createToken("x", sc, { expiresAt: "2999-01-01T00:00:00Z", expiresInDays: 1 }), /not both/);
});

test("expiry: expiresAt needs ISO 8601 with a zone, is normalised to UTC and capped", () => {
  const future = new Date(Date.now() + 5 * 86_400_000);
  const iso = future.toISOString();
  assert.equal(createToken("z", sc, { expiresAt: iso }).expires_at, iso);
  const plus2h = new Date(Math.floor(future.getTime() / 1000) * 1000 + 2 * 3600_000).toISOString().slice(0, 19) + "+02:00";
  assert.equal(createToken("z2", sc, { expiresAt: plus2h }).expires_at, iso.replace(/\.\d+Z$/, ".000Z"));
  assert.throws(() => createToken("x", sc, { expiresAt: iso.slice(0, 19) }), /explicit Z or offset/, "no zone");
  assert.throws(() => createToken("x", sc, { expiresAt: "10000-01-01T00:00:00Z" }), /explicit Z or offset/);
  assert.throws(() => createToken("x", sc, { expiresAt: "9999-12-31T00:00:00Z" }), /at most 3650 days/);
  assert.throws(() => createToken("x", sc, { expiresAt: "Dec 1 2026" }), /explicit Z or offset/);
  assert.throws(() => createToken("x", sc, { expiresAt: "2026-12-01" }), /explicit Z or offset/);
  assert.throws(() => createToken("x", sc, { expiresAt: "2020-01-01T00:00:00+02:00" }), /in the future/);
});

test("expiry: one SQL rule (julianday) for verify, list and count; unparseable fails closed", async () => {
  const { db } = await import("../db");
  const { checkToken, countActiveTokens } = await import("./tokens");
  const set = (id: string, v: string) => db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(v, id);
  const t = createToken("rule", sc, { expiresInDays: 30 });
  const before = countActiveTokens();

  set(t.id, db.prepare("SELECT datetime('now','+7 days') AS d").get()!.d as string); // hand-edited, space-separated
  assert.equal(checkToken(t.token).status, "ok");
  assert.equal(listTokens().find((x) => x.id === t.id)!.expired, false);
  assert.equal(countActiveTokens(), before);

  set(t.id, db.prepare("SELECT datetime('now','-1 hours') AS d").get()!.d as string);
  assert.equal(checkToken(t.token).status, "expired");
  assert.equal(listTokens().find((x) => x.id === t.id)!.expired, true);
  assert.equal(countActiveTokens(), before - 1);

  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    set(t.id, "not a date");
    assert.equal(checkToken(t.token).status, "expired");
    assert.equal(checkToken(t.token).status, "expired");
    assert.equal(listTokens().find((x) => x.id === t.id)!.expired, true);
    assert.equal(countActiveTokens(), before - 1);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.filter((w) => w.includes(t.id)).length, 1, "warned once");

  assert.equal(checkToken("sb_unknown").status, "invalid");
  const r = createToken("rev", sc, { expiresInDays: 1 });
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
  assert.equal(checkToken(r.token).status, "invalid", "revoked is not expired");
});

after(cleanup);
