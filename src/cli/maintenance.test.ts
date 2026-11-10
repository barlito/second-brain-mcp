import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const tmpDir = mkdtempSync(join(tmpdir(), "second-brain-maint-test-"));
process.env.DB_PATH = join(tmpDir, "test.db");

let m: typeof import("./maintenance");
let db: typeof import("../db").db;

before(async () => {
  m = await import("./maintenance");
  ({ db } = await import("../db"));
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES ('2000-01-01T00:00:00.000Z','a','ok')").run();
});

after(() => rmSync(tmpDir, { recursive: true, force: true }));

test("backupDb produces a readable copy, creates parent dir, refuses overwrite", async () => {
  const dest = join(tmpDir, "nested", "dir", "copy.db");
  assert.equal(await m.backupDb(dest), dest);
  const copy = new Database(dest, { readonly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 1);
  assert.equal(copy.pragma("user_version", { simple: true }), 2);
  copy.close();
  await assert.rejects(m.backupDb(dest), /already exists/);
});

test("parseDays validates input", () => {
  assert.equal(m.parseDays("30"), 30);
  assert.throws(() => m.parseDays(undefined));
  assert.throws(() => m.parseDays("-1"));
  assert.throws(() => m.parseDays("abc"));
});

test("CLI: backup and prune-audit", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "maintenance.ts"), ...args], {
      env: process.env,
      encoding: "utf8",
    });
  const dest = join(tmpDir, "cli-copy.db");
  const b = run("backup", dest);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(existsSync(dest));
  assert.notEqual(run("backup", dest).status, 0);

  const p = run("prune-audit", "--days", "30");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /Pruned 1 /);
  assert.notEqual(run("prune-audit").status, 0);
});
