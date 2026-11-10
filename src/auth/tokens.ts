import { randomBytes, randomUUID, createHash } from "node:crypto";
import { db } from "../db";

export interface Scope {
  project: string;
  section: string;
  permission: "read" | "write";
}

export interface CreatedToken {
  id: string;
  name: string;
  token: string;
}

export interface VerifiedToken {
  tokenId: string;
  name: string;
  scopes: Scope[];
}

export interface TokenListEntry {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  scopes: Scope[];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Prepared once at module load and reused — verifyToken is the hot path (every MCP request in PR4).
const insertTokenStmt = db.prepare(
  "INSERT INTO tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
);
const insertScopeStmt = db.prepare(
  "INSERT INTO scopes (token_id, project, section, permission) VALUES (?, ?, ?, ?)",
);
const selectActiveTokenByHashStmt = db.prepare(
  "SELECT id, name FROM tokens WHERE token_hash = ? AND revoked_at IS NULL",
);
const updateLastUsedAtStmt = db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?");
const selectScopesByTokenIdStmt = db.prepare(
  "SELECT project, section, permission FROM scopes WHERE token_id = ?",
);
const revokeTokenStmt = db.prepare(
  "UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
);
const selectAllTokensStmt = db.prepare(
  "SELECT id, name, created_at, revoked_at, last_used_at FROM tokens ORDER BY created_at",
);

export function createToken(name: string, scopes: Scope[]): CreatedToken {
  const id = randomUUID();
  const token = `sb_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const createdAt = new Date().toISOString();

  db.transaction(() => {
    insertTokenStmt.run(id, name, tokenHash, createdAt);
    for (const scope of scopes) {
      insertScopeStmt.run(id, scope.project, scope.section, scope.permission);
    }
  })();

  return { id, name, token };
}

export function verifyToken(plaintextToken: string): VerifiedToken | null {
  const tokenHash = hashToken(plaintextToken);

  const row = selectActiveTokenByHashStmt.get(tokenHash) as
    | { id: string; name: string }
    | undefined;

  if (!row) return null;

  updateLastUsedAtStmt.run(new Date().toISOString(), row.id);

  const scopes = selectScopesByTokenIdStmt.all(row.id) as Scope[];

  return { tokenId: row.id, name: row.name, scopes };
}

export function revokeToken(id: string): boolean {
  const result = revokeTokenStmt.run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function listTokens(): TokenListEntry[] {
  const tokens = selectAllTokensStmt.all() as Omit<TokenListEntry, "scopes">[];

  return tokens.map((t) => ({
    ...t,
    scopes: selectScopesByTokenIdStmt.all(t.id) as Scope[],
  }));
}
