import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "second-brain-audit-test-"));
process.env.DB_PATH = join(tmpDir, "test.db");

let audit: typeof import("./audit");
let db: typeof import("./db").db;

before(async () => {
  audit = await import("./audit");
  ({ db } = await import("./db"));
});

type Row = Record<string, string | null>;
const last = () => db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as Row;

test("logAudit stays backward compatible and accepts clientIp", () => {
  audit.logAudit({ tokenId: "t", tokenName: "n", action: "read", result: "ok", clientIp: "1.2.3.4" });
  const r = last();
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
  audit.logAudit({ action: "read", result: "ok", project: big, section: big, note: big, detail: big });
  const r = last();
  for (const k of ["project", "section", "note", "detail"]) {
    assert.equal(r[k]!.length, audit.MAX_FIELD_LEN);
  }
});

test("pruneAudit deletes only old rows and returns the count", () => {
  db.prepare("DELETE FROM audit_log").run();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES (?, 'a', 'ok')").run(old);
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES (?, 'a', 'ok')").run(old);
  audit.logAudit({ action: "a", result: "ok" });
  assert.equal(audit.pruneAudit(30), 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 1);
  assert.throws(() => audit.pruneAudit(-1));
});
