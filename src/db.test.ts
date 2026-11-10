import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const tmpDir = mkdtempSync(join(tmpdir(), "second-brain-db-test-"));
process.env.DB_PATH = join(tmpDir, "main.db");

const OLD_SCHEMA = `
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
  );
  CREATE TABLE scopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    project TEXT NOT NULL, section TEXT NOT NULL,
    permission TEXT NOT NULL CHECK(permission IN ('read','write')),
    UNIQUE(token_id, project, section, permission)
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
    token_id TEXT NOT NULL, token_name TEXT NOT NULL, action TEXT NOT NULL,
    project TEXT, section TEXT, note TEXT, result TEXT NOT NULL, detail TEXT, git_commit TEXT
  );
`;

test("old-schema DB with rows migrates to v2 with data intact, re-run is a no-op", async () => {
  const { runMigrations } = await import("./db");
  const d = new Database(join(tmpDir, "old.db"));
  d.pragma("foreign_keys = ON");
  d.exec(OLD_SCHEMA);
  d.prepare("INSERT INTO tokens VALUES ('t1','n','h','2024-01-01',NULL,NULL)").run();
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('t1','p','s','read')").run();
  d.prepare(
    "INSERT INTO audit_log (ts, token_id, token_name, action, result, detail) VALUES ('2024-01-02','t1','n','read','ok','x')",
  ).run();
  assert.equal(d.pragma("user_version", { simple: true }), 0);

  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 2);
  assert.equal(d.pragma("foreign_keys", { simple: true }), 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM tokens").get() as { c: number }).c, 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c, 1);
  const row = d.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;
  assert.equal(row.token_id, "t1");
  assert.equal(row.detail, "x");
  assert.equal(row.client_ip, null);
  // token_id now nullable
  d.prepare("INSERT INTO audit_log (ts, action, result) VALUES ('t','auth','denied')").run();

  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 2);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 2);
  d.close();
});

test("fresh DB lands at v2", async () => {
  const { runMigrations } = await import("./db");
  const d = new Database(":memory:");
  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 2);
  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 2);
  d.close();
});

test("DB file is created with mode 0600", async () => {
  await import("./db");
  assert.equal(statSync(process.env.DB_PATH!).mode & 0o777, 0o600);
});
