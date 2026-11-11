import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { cleanup, makeTempDb } from "./test-support/fixtures";

const tmpDir = dirname(makeTempDb("main.db"));
after(cleanup);

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

test("old-schema DB with rows migrates to v4 with data intact, re-run is a no-op", async () => {
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
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  assert.equal(d.pragma("foreign_keys", { simple: true }), 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM tokens").get() as { c: number }).c, 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c, 1);
  assert.deepEqual(d.prepare("SELECT space, project, section, permission FROM scopes").all(), [
    { space: "!legacy", project: "p", section: "s", permission: "read" },
  ]);
  const row = d.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;
  assert.equal(row.token_id, "t1");
  assert.equal(row.detail, "x");
  assert.equal(row.client_ip, null);
  assert.equal(row.space, null);
  // token_id now nullable
  d.prepare("INSERT INTO audit_log (ts, action, result) VALUES ('t','auth','denied')").run();

  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 2);
  d.close();
});

test("fresh DB lands at v4", async () => {
  const { runMigrations } = await import("./db");
  const d = new Database(":memory:");
  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  d.close();
});

test("DB file is created with mode 0600", async () => {
  await import("./db");
  assert.equal(statSync(process.env.DB_PATH!).mode & 0o777, 0o600);
});

test("legacy DB with an orphan scopes row still migrates to v4 (orphan dropped)", async () => {
  const { runMigrations } = await import("./db");
  const d = new Database(join(tmpDir, "orphan.db"));
  d.exec(OLD_SCHEMA);
  d.pragma("foreign_keys = OFF");
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('ghost','p','s','read')").run();
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c, 0); // orphan dropped, not carried over
  d.close();
});

test("a migration leaving FK violations in a table it touched fails and rolls back", async () => {
  const { runMigrations, MIGRATIONS } = await import("./db");
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d, [MIGRATIONS[0]]);
  const bad = {
    tables: ["scopes"],
    up: (x: Database.Database) => {
      x.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('nope','p','s','read')").run();
    },
  };
  // runMigrations turns FK enforcement off, so the orphan insert succeeds and only the check catches it.
  assert.throws(() => runMigrations(d, [MIGRATIONS[0], bad]), /foreign key/);
  assert.equal(d.pragma("user_version", { simple: true }), 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c, 0);
  d.close();
});

test("a migration that throws halfway rolls back, leaving the previous version and data", async () => {
  const { runMigrations, MIGRATIONS } = await import("./db");
  const d = new Database(":memory:");
  runMigrations(d, [MIGRATIONS[0]]);
  d.prepare("INSERT INTO tokens VALUES ('t1','n','h','2024-01-01',NULL,NULL)").run();
  const boom = {
    tables: [],
    up: (x: Database.Database) => {
      x.exec("DELETE FROM tokens; CREATE TABLE half (a INTEGER);");
      throw new Error("boom");
    },
  };
  assert.throws(() => runMigrations(d, [MIGRATIONS[0], boom]), /boom/);
  assert.equal(d.pragma("user_version", { simple: true }), 1);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM tokens").get() as { c: number }).c, 1);
  assert.equal(d.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
  d.close();
});

test("a second handle skips a migration another handle already applied", async () => {
  const { migrateStep, MIGRATIONS } = await import("./db");
  const file = join(tmpDir, "race.db");
  const a = new Database(file);
  const b = new Database(file);
  b.pragma("busy_timeout = 5000");
  let runs = 0;
  const counted = MIGRATIONS.map((m) => ({
    ...m,
    up: (x: Database.Database) => {
      runs++;
      m.up(x);
    },
  }));
  // Both handles observed v0; A wins, B must re-read inside its transaction and skip.
  assert.equal(b.pragma("user_version", { simple: true }), 0);
  migrateStep(a, 0, counted);
  migrateStep(a, 1, counted);
  migrateStep(a, 2, counted);
  migrateStep(a, 3, counted);
  migrateStep(b, 0, counted);
  migrateStep(b, 1, counted);
  migrateStep(b, 2, counted);
  migrateStep(b, 3, counted);
  assert.equal(runs, 4);
  assert.equal(b.pragma("user_version", { simple: true }), 4);
  a.close();
  b.close();
});

test("an existing 0644 DB file is chmod'ed to 0600 on open", async () => {
  const { spawnSync } = await import("node:child_process");
  const file = join(tmpDir, "perm.db");
  writeFileSync(file, "");
  chmodSync(file, 0o644);
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", `require(${JSON.stringify(join(__dirname, "db.ts"))})`], {
    env: { ...process.env, DB_PATH: file },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("migration 3: legacy scopes get space='!legacy', fail closed, and the new unique key allows same project in other spaces", async () => {
  const { runMigrations, MIGRATIONS } = await import("./db");
  const { checkScope } = await import("./acl/check");
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d, MIGRATIONS.slice(0, 2));
  d.prepare("INSERT INTO tokens VALUES ('t1','n','h','2024-01-01',NULL,NULL)").run();
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('t1','p','s','write')").run();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(String(m));
  try {
    runMigrations(d, MIGRATIONS);
  } finally {
    console.warn = orig;
  }
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  assert.ok(warns.some((w) => /moved 1 scope\(s\) to space '!legacy'/.test(w)));
  assert.ok(!warns.some((w) => /orphan/.test(w)));
  const scopes = d.prepare("SELECT space, project, section, permission FROM scopes WHERE token_id = 't1'").all() as never[];
  assert.deepEqual(scopes, [{ space: "!legacy", project: "p", section: "s", permission: "write" }]);
  // Not a valid slug, so no real space (even one named "legacy") can match it.
  assert.equal(checkScope(scopes, "legacy", "p", "s", "write"), false);
  assert.equal(checkScope(scopes, "perso", "p", "s", "write"), false);
  assert.equal(checkScope(scopes, "pro", "p", "s", "write"), false);
  d.prepare("INSERT INTO scopes (token_id, space, project, section, permission) VALUES ('t1','perso','p','s','write')").run();
  assert.throws(() =>
    d.prepare("INSERT INTO scopes (token_id, space, project, section, permission) VALUES ('t1','perso','p','s','write')").run(),
  );
  assert.equal(d.pragma("foreign_key_check") instanceof Array && (d.pragma("foreign_key_check") as unknown[]).length, 0);
  d.close();
});

test("migration 3 counts carried rows and orphans separately", async () => {
  const { runMigrations, MIGRATIONS } = await import("./db");
  const d = new Database(":memory:");
  runMigrations(d, MIGRATIONS.slice(0, 2));
  d.pragma("foreign_keys = OFF");
  d.prepare("INSERT INTO tokens VALUES ('t1','n','h','2024-01-01',NULL,NULL)").run();
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('t1','p','s','read')").run();
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('ghost','p','s','read')").run();
  d.prepare("INSERT INTO scopes (token_id, project, section, permission) VALUES ('ghost','p','s2','read')").run();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(String(m));
  try {
    runMigrations(d, MIGRATIONS);
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => /moved 1 scope\(s\)/.test(w)));
  assert.ok(warns.some((w) => /dropped 2 orphan/.test(w)));
  d.close();
});

test("migration 4 renames space='legacy' rows from the first migration 3 to '!legacy'", async () => {
  const { runMigrations, MIGRATIONS } = await import("./db");
  const d = new Database(":memory:");
  runMigrations(d, MIGRATIONS.slice(0, 3));
  d.prepare("INSERT INTO tokens VALUES ('t1','n','h','2024-01-01',NULL,NULL)").run();
  d.prepare("INSERT INTO scopes (token_id, space, project, section, permission) VALUES ('t1','legacy','p','s','read')").run();
  d.prepare("INSERT INTO scopes (token_id, space, project, section, permission) VALUES ('t1','pro','p','s','read')").run();
  runMigrations(d, MIGRATIONS);
  assert.equal(d.pragma("user_version", { simple: true }), 4);
  assert.deepEqual(d.prepare("SELECT space FROM scopes ORDER BY id").all(), [{ space: "!legacy" }, { space: "pro" }]);
  d.close();
});
