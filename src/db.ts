import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  throw new Error("DB_PATH environment variable is required");
}

// Create the file 0600 up front so the token-hash DB is never world-readable.
if (dbPath !== ":memory:") {
  if (!existsSync(dbPath)) closeSync(openSync(dbPath, "a", 0o600));
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // best effort (e.g. file owned by another user)
  }
}

// Ordered migrations; index + 1 == schema version stored in PRAGMA user_version.
// Never edit a released migration — append a new one.
export interface Migration {
  // Tables the migration modifies; only these are FK-checked afterwards.
  tables: string[];
  up: (d: Database.Database) => void;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: original schema (IF NOT EXISTS so pre-versioning DBs are adopted as-is)
  { tables: [], up: (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        project TEXT NOT NULL,
        section TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('read','write')),
        UNIQUE(token_id, project, section, permission)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        token_id TEXT NOT NULL,
        token_name TEXT NOT NULL,
        action TEXT NOT NULL,
        project TEXT, section TEXT, note TEXT,
        result TEXT NOT NULL,
        detail TEXT,
        git_commit TEXT
      );
    `);
  } },
  // 2: audit_log with nullable token_id/token_name (401s) + client_ip
  { tables: ["audit_log"], up: (d) => {
    d.exec(`
      CREATE TABLE audit_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        token_id TEXT,
        token_name TEXT,
        action TEXT NOT NULL,
        project TEXT, section TEXT, note TEXT,
        result TEXT NOT NULL,
        detail TEXT,
        git_commit TEXT,
        client_ip TEXT
      );
      INSERT INTO audit_log_new (id, ts, token_id, token_name, action, project, section, note, result, detail, git_commit)
        SELECT id, ts, token_id, token_name, action, project, section, note, result, detail, git_commit FROM audit_log;
      DROP TABLE audit_log;
      ALTER TABLE audit_log_new RENAME TO audit_log;
    `);
  } },
  // 3: scopes gain a NOT NULL space level; existing rows become space='legacy' (matches no
  // real space, so they fail closed until re-issued). audit_log gets a nullable space.
  { tables: ["scopes", "audit_log"], up: (d) => {
    // Orphan rows (token gone, FK enforcement was off) are dropped rather than carried over.
    const legacy = (d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c;
    if (legacy > 0) {
      console.warn(
        `warning: migration 3 moved ${legacy} scope(s) to space 'legacy'; they grant nothing until tokens are re-issued with space:project:section:permission scopes`,
      );
    }
    d.exec(`
      CREATE TABLE scopes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        project TEXT NOT NULL,
        section TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('read','write')),
        UNIQUE(token_id, space, project, section, permission)
      );
      INSERT INTO scopes_new (id, token_id, space, project, section, permission)
        SELECT id, token_id, 'legacy', project, section, permission FROM scopes
        WHERE token_id IN (SELECT id FROM tokens);
      DROP TABLE scopes;
      ALTER TABLE scopes_new RENAME TO scopes;
      ALTER TABLE audit_log ADD COLUMN space TEXT;
    `);
  } },
];

// Applies migration index `v` under BEGIN IMMEDIATE. user_version is re-read inside the
// write lock so a concurrent process that already applied it makes this a no-op.
export function migrateStep(d: Database.Database, v: number, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
  d.transaction(() => {
    const cur = d.pragma("user_version", { simple: true }) as number;
    if (cur > v) return;
    migrations[v].up(d);
    d.pragma(`user_version = ${v + 1}`);
    for (const t of migrations[v].tables) {
      const bad = d.pragma(`foreign_key_check(${JSON.stringify(t)})`) as unknown[];
      if (bad.length > 0) throw new Error(`migration ${v + 1} left foreign key violations in ${t}`);
    }
  }).immediate();
}

// Applies pending migrations, each in its own transaction. Idempotent and multi-process safe.
export function runMigrations(d: Database.Database, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
  const current = d.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(`DB schema version ${current} is newer than this build supports (${migrations.length})`);
  }
  // foreign_keys can't be toggled inside a transaction; off while rebuilding tables.
  const fkWasOn = d.pragma("foreign_keys", { simple: true }) === 1;
  if (fkWasOn) d.pragma("foreign_keys = OFF");
  try {
    for (let v = current; v < migrations.length; v++) migrateStep(d, v, migrations);
    // Pre-existing violations in untouched tables must not brick startup; just report.
    const bad = d.pragma("foreign_key_check") as unknown[];
    if (bad.length > 0) console.warn(`warning: ${bad.length} pre-existing foreign key violation(s) in DB`);
  } finally {
    if (fkWasOn) d.pragma("foreign_keys = ON");
  }
}

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
runMigrations(db);
