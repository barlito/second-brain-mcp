import { randomBytes, randomUUID, createHash } from "node:crypto";
import { db } from "../db";
import { isValidSlug } from "../vault/paths";
import { PERMISSIONS, Scope } from "./types";

export type { Scope };

export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenValidationError";
  }
}

// Only re-write last_used_at when the stored value is older than this.
const LAST_USED_THROTTLE_MS = 60_000;

// Validates and normalises input. Duplicate scopes are silently de-duplicated
// (first occurrence wins, order kept); anything else invalid is rejected.
export function validateTokenInput(name: unknown, scopes: unknown): { name: string; scopes: Scope[] } {
  if (typeof name !== "string") throw new TokenValidationError("name is required");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new TokenValidationError("name must be 1-64 characters");
  }
  // name ends up in git commit messages
  if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(trimmed)) {
    throw new TokenValidationError("name must not contain control, format or newline characters");
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TokenValidationError("at least one scope is required");
  }
  const seen = new Set<string>();
  const out: Scope[] = [];
  for (const s of scopes as Scope[]) {
    if (!s || typeof s.project !== "string" || !isValidSlug(s.project)) {
      throw new TokenValidationError(`invalid project slug: ${JSON.stringify(s?.project)}`);
    }
    if (typeof s.section !== "string" || !isValidSlug(s.section)) {
      throw new TokenValidationError(`invalid section slug: ${JSON.stringify(s.section)}`);
    }
    if (!(PERMISSIONS as readonly string[]).includes(s.permission)) {
      throw new TokenValidationError(
        `invalid permission ${JSON.stringify(s.permission)}, must be one of: ${PERMISSIONS.join(", ")}`,
      );
    }
    const key = `${s.project}\0${s.section}\0${s.permission}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ project: s.project, section: s.section, permission: s.permission });
  }
  return { name: trimmed, scopes: out };
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
  "SELECT id, name, last_used_at FROM tokens WHERE token_hash = ? AND revoked_at IS NULL",
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
  const v = validateTokenInput(name, scopes);
  name = v.name;
  scopes = v.scopes;
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
    | { id: string; name: string; last_used_at: string | null }
    | undefined;

  if (!row) return null;

  // Throttled: avoid a synchronous write on every request.
  const now = Date.now();
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  // last > now: clock stepped back, treat as stale.
  if (Number.isNaN(last) || last > now || now - last >= LAST_USED_THROTTLE_MS) {
    updateLastUsedAtStmt.run(new Date(now).toISOString(), row.id);
  }

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
