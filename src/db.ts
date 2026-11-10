import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  throw new Error("DB_PATH environment variable is required");
}

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
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
