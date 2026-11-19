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
  // 3: scopes gain a NOT NULL space level; existing rows move to the sentinel space
  // '!legacy'. '!' fails slug validation, so no token scope, tool argument or vault path can
  // ever equal it: those rows fail closed until the tokens are re-issued. audit_log gets a
  // nullable space. (Originally the sentinel was 'legacy', a valid slug; see migration 4.)
  { tables: ["scopes", "audit_log"], up: (d) => {
    // Orphan rows (token gone, FK enforcement was off) are dropped rather than carried over.
    const carried = (d.prepare("SELECT COUNT(*) c FROM scopes WHERE token_id IN (SELECT id FROM tokens)").get() as { c: number }).c;
    const total = (d.prepare("SELECT COUNT(*) c FROM scopes").get() as { c: number }).c;
    if (carried > 0) {
      console.warn(
        `warning: migration 3 moved ${carried} scope(s) to space '!legacy'; they grant nothing until tokens are re-issued with space:project:section:permission scopes`,
      );
    }
    if (total > carried) {
      console.warn(`warning: migration 3 dropped ${total - carried} orphan scope(s) whose token no longer exists`);
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
        SELECT id, token_id, '!legacy', project, section, permission FROM scopes
        WHERE token_id IN (SELECT id FROM tokens);
      DROP TABLE scopes;
      ALTER TABLE scopes_new RENAME TO scopes;
      ALTER TABLE audit_log ADD COLUMN space TEXT;
    `);
  } },
  // 4: DBs that already ran the first version of migration 3 hold space='legacy' (a valid
  // slug a real space could later claim); rename those rows to the unmatchable sentinel.
  { tables: ["scopes"], up: (d) => {
    d.exec("UPDATE scopes SET space = '!legacy' WHERE space = 'legacy'");
  } },
  // 5: scopes.permission CHECK also allows 'propose' (kb_propose inbox permission).
  { tables: ["scopes"], up: (d) => {
    d.exec(`
      CREATE TABLE scopes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        project TEXT NOT NULL,
        section TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('read','write','propose')),
        UNIQUE(token_id, space, project, section, permission)
      );
      INSERT INTO scopes_new (id, token_id, space, project, section, permission)
        SELECT id, token_id, space, project, section, permission FROM scopes;
      DROP TABLE scopes;
      ALTER TABLE scopes_new RENAME TO scopes;
    `);
  } },
  // 6: optional token expiry (ISO UTC string; NULL = never expires)
  { tables: [], up: (d) => {
    d.exec("ALTER TABLE tokens ADD COLUMN expires_at TEXT");
  } },
  // 7: token-less sessions + access requests. A grant is a tokens row with kind='session'
  // and session_id set: it shares the scopes/audit/ACL path but its hash is of a random,
  // never-disclosed secret, so it can never authenticate as a Bearer token.
  { tables: ["tokens", "sessions", "access_requests"], up: (d) => {
    d.exec(`
      ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'bearer';
      ALTER TABLE tokens ADD COLUMN session_id TEXT;
      CREATE INDEX idx_tokens_session ON tokens(session_id);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sid_hash TEXT NOT NULL UNIQUE,
        client_name TEXT NOT NULL,
        client_version TEXT NOT NULL,
        remote_ip TEXT,
        ip_key TEXT,
        connector_key_id TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        first_grant_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX idx_sessions_ip ON sessions(ip_key);
      CREATE TABLE connector_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_enc TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE TABLE access_requests (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        space TEXT,
        project TEXT,
        access TEXT CHECK(access IS NULL OR access IN ('read','write')),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        token_id TEXT,
        scopes TEXT,
        elevation INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_access_requests_session ON access_requests(session_id);
    `);
  } },
  // Token-less access requests are approved by id: the verification code is gone.
  { tables: ["access_requests"], up: (d) => {
    d.exec("ALTER TABLE access_requests DROP COLUMN code");
  } },
  // Web Push: one row per subscribed device, and the single VAPID keypair (private key sealed).
  { tables: [], up: (d) => {
    d.exec(`
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_ok_at TEXT
      );
      CREATE TABLE push_vapid (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        public_key TEXT NOT NULL,
        private_key_sealed TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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
