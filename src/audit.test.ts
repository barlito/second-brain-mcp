import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb } from "./test-support/fixtures";

makeTempDb();

let audit: typeof import("./audit");
let db: typeof import("./db").db;

after(cleanup);

before(async () => {
  audit = await import("./audit");
  ({ db } = await import("./db"));
});

type Row = Record<string, string | null>;
const last = () => db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as Row;

test("logAudit stays backward compatible and accepts clientIp", () => {
  audit.logAudit({ tokenId: "t", tokenName: "n", action: "read", result: "ok", clientIp: "1.2.3.4", space: "sp" });
  const r = last();
  assert.equal(r.space, "sp");
  assert.equal(r.token_id, "t");
  assert.equal(r.client_ip, "1.2.3.4");
});

test("logAuthFailure writes a null-token denied auth row", () => {
  audit.logAuthFailure({ clientIp: "9.9.9.9", reason: "bad token" });
  const r = last();
  assert.equal(r.action, "auth");
  assert.equal(r.result, "denied");
  assert.equal(r.token_id, null);
  assert.equal(r.token_name, null);
  assert.equal(r.client_ip, "9.9.9.9");
  assert.equal(r.detail, "bad token");
});

test("free-text fields are truncated", () => {
  const big = "x".repeat(10_000);
  audit.logAudit({ action: "read", result: "ok", space: big, project: big, section: big, note: big, detail: big });
  const r = last();
  for (const k of ["space", "project", "section", "note", "detail"]) {
    assert.equal(r[k]!.length, audit.MAX_FIELD_LEN);
  }
});

test("pruneAudit deletes only old rows and returns the count", () => {
  // Only rows with this test's own action are asserted on; rows from other tests are all recent.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES (?, 'prune-test', 'ok')").run(old);
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES (?, 'prune-test', 'ok')").run(old);
  audit.logAudit({ action: "prune-test", result: "ok" });
  assert.equal(audit.pruneAudit(30), 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'prune-test'").get() as { c: number }).c,
    1,
  );
  assert.throws(() => audit.pruneAudit(-1));
});

test("pruneAudit rejects out-of-range day counts", () => {
  assert.throws(() => audit.pruneAudit(999_999_999), /between 0 and 36500/);
  assert.throws(() => audit.pruneAudit(-1), /between 0 and/);
  assert.equal(audit.pruneAudit(36500), 0);
});
