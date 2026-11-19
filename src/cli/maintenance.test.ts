import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { cleanup, makeTempDb, tmp } from "../test-support/fixtures";

makeTempDb();
const tmpDir = tmp("maint");

let m: typeof import("./maintenance");
let db: typeof import("../db").db;

before(async () => {
  m = await import("./maintenance");
  ({ db } = await import("../db"));
  db.prepare("INSERT INTO audit_log (ts, action, result) VALUES ('2000-01-01T00:00:00.000Z','a','ok')").run();
});

after(cleanup);

test("backupDb produces a readable copy, creates parent dir, refuses overwrite", async () => {
  const dest = join(tmpDir, "nested", "dir", "copy.db");
  assert.equal(await m.backupDb(dest), dest);
  const copy = new Database(dest, { readonly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 1);
  assert.equal(copy.pragma("user_version", { simple: true }), 9);
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

test("backup file is 0600 and a second backup fails without touching the first", async () => {
  const dest = join(tmpDir, "mode.db");
  await m.backupDb(dest);
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  const before = readFileSync(dest);
  await assert.rejects(m.backupDb(dest), /already exists/);
  assert.ok(before.equals(readFileSync(dest)));
});

test("parseDays rejects huge values", () => {
  assert.equal(m.parseDays("36500"), 36500);
  assert.throws(() => m.parseDays("999999999"), /at most 36500/);
});
