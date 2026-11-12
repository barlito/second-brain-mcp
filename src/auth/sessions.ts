// Server-issued MCP sessions for clients that connect without a Bearer token. The transport
// stays stateless; a session only identifies a client across requests so that an admin-approved
// access request can be bound to it. The secret Mcp-Session-Id is stored hashed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../db";
import { SessionGrant } from "./context";
import { Scope } from "./types";
import { validateTokenInput } from "./tokens";

export const NOGRANT_IDLE_MS = 60 * 60_000;
const LAST_SEEN_THROTTLE_MS = 60_000;
const DAY_MS = 86_400_000;

// SESSION_IDLE_DAYS: sliding idle expiry of a session that holds grants (default 5).
export function sessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SESSION_IDLE_DAYS);
  return Number.isFinite(n) && n > 0 ? n * DAY_MS : 5 * DAY_MS;
}

export const hashSid = (sid: string): string => createHash("sha256").update(sid).digest("hex");

// Free text from the client ends up in admin pages, audit rows and token names.
export function cleanText(v: unknown, max: number, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return (s || fallback).slice(0, max);
}

export function clientSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "");
  return s || "client";
}

export interface SessionRow {
  id: string;
  client_name: string;
  client_version: string;
  remote_ip: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

const insertSession = db.prepare(
  "INSERT INTO sessions (id, sid_hash, client_name, client_version, remote_ip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const selectByHash = db.prepare("SELECT * FROM sessions WHERE sid_hash = ?");
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?");
const selectGrantTokens = db.prepare(
  "SELECT id, name FROM tokens WHERE session_id = ? AND kind = 'session' AND revoked_at IS NULL ORDER BY created_at, rowid",
);
const selectScopes = db.prepare("SELECT space, project, section, permission FROM scopes WHERE token_id = ?");

export function createSession(input: { clientName: unknown; clientVersion: unknown; ip?: string }): { sid: string; id: string } {
  const sid = randomBytes(32).toString("hex");
  const id = randomUUID();
  const now = new Date().toISOString();
  insertSession.run(id, hashSid(sid), cleanText(input.clientName, 64, "unknown"), cleanText(input.clientVersion, 32, "?"), input.ip ?? null, now, now);
  return { sid, id };
}

// Non-revoked grants with their scopes.
export function listGrants(sessionId: string): SessionGrant[] {
  return (selectGrantTokens.all(sessionId) as Array<{ id: string; name: string }>).map((t) => ({
    tokenId: t.id,
    name: t.name,
    scopes: selectScopes.all(t.id) as Scope[],
  }));
}

export interface LiveSession {
  id: string;
  clientName: string;
  clientVersion: string;
  grants: SessionGrant[];
}

// Sliding expiry: idle longer than SESSION_IDLE_DAYS with grants, NOGRANT_IDLE_MS without.
function isExpired(row: SessionRow, hasGrant: boolean, now: number, env?: NodeJS.ProcessEnv): boolean {
  const last = Date.parse(row.last_seen_at);
  const ttl = hasGrant ? sessionIdleMs(env) : NOGRANT_IDLE_MS;
  // last > now (clock stepped back) is not expiry.
  return Number.isNaN(last) || now - last >= ttl;
}

// Resolves the secret session id; null for unknown, revoked or expired (the caller answers 404 so the
// client re-initializes). Refreshes last_seen_at (throttled) = the sliding window.
export function lookupSession(sid: string): LiveSession | null {
  const row = selectByHash.get(hashSid(sid)) as SessionRow | undefined;
  if (!row || row.revoked_at) return null;
  const grants = listGrants(row.id);
  const now = Date.now();
  if (isExpired(row, grants.length > 0, now)) {
    endSession(row.id);
    return null;
  }
  const last = Date.parse(row.last_seen_at);
  if (last > now || now - last >= LAST_SEEN_THROTTLE_MS) {
    try {
      touchSession.run(new Date(now).toISOString(), row.id);
    } catch (err) {
      console.error(`session last_seen update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { id: row.id, clientName: row.client_name, clientVersion: row.client_version, grants };
}

// Revokes every grant of the session and deletes it (and, by cascade, its requests).
export function endSession(id: string): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL").run(at, id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  })();
}

// Admin revoke: the grants die immediately and the session id stops resolving (client re-initializes).
export function revokeSession(id: string): boolean {
  const at = new Date().toISOString();
  return db.transaction(() => {
    const r = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
    if (r.changes === 0) return false;
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL").run(at, id);
    return true;
  })();
}

// Live sessions without any grant (what an anonymous flood can fill).
export function countGrantlessSessions(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s WHERE revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.session_id = s.id AND t.kind = 'session' AND t.revoked_at IS NULL)`,
      )
      .get() as { n: number }
  ).n;
}

// Deletes expired/revoked sessions (revoking their grants) and stale access requests.
export function pruneSessions(now = Date.now(), env?: NodeJS.ProcessEnv): number {
  const rows = db
    .prepare(
      `SELECT s.*, EXISTS (SELECT 1 FROM tokens t WHERE t.session_id = s.id AND t.kind = 'session' AND t.revoked_at IS NULL) AS has_grant
       FROM sessions s`,
    )
    .all() as Array<SessionRow & { has_grant: number }>;
  let n = 0;
  for (const r of rows) {
    if (r.revoked_at || isExpired(r, r.has_grant === 1, now, env)) {
      endSession(r.id);
      n++;
    }
  }
  const dayAgo = new Date(now - DAY_MS).toISOString();
  db.prepare("DELETE FROM access_requests WHERE (status = 'pending' AND expires_at < ?) OR (status != 'pending' AND decided_at < ?)").run(dayAgo, dayAgo);
  return n;
}

// Periodic pruning; unref'd so it never keeps the process alive. Returns a stop function.
export function startSessionPruning(intervalMs = 5 * 60_000): () => void {
  const t = setInterval(() => {
    try {
      pruneSessions();
    } catch (err) {
      console.error(`session pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

export interface ActiveSession {
  id: string;
  client_name: string;
  client_version: string;
  remote_ip: string | null;
  created_at: string;
  last_seen_at: string;
  grants: Array<{ tokenId: string; name: string; scopes: Scope[] }>;
}

// Sessions that hold at least one active grant (the admin "active sessions" table).
export function listActiveSessions(): ActiveSession[] {
  const rows = db.prepare("SELECT * FROM sessions WHERE revoked_at IS NULL ORDER BY last_seen_at DESC").all() as SessionRow[];
  return rows
    .map((r) => ({ id: r.id, client_name: r.client_name, client_version: r.client_version, remote_ip: r.remote_ip, created_at: r.created_at, last_seen_at: r.last_seen_at, grants: listGrants(r.id) }))
    .filter((s) => s.grants.length > 0);
}

// A grant: a tokens row (kind='session', hash of a secret nobody ever sees) + its scopes.
// Runs inside the caller's transaction when there is one.
export function insertGrant(sessionId: string, name: string, scopes: Scope[]): { id: string; name: string; scopes: Scope[] } {
  const v = validateTokenInput(name.slice(0, 64), scopes);
  const id = randomUUID();
  const hash = hashSid(randomBytes(32).toString("hex"));
  db.prepare("INSERT INTO tokens (id, name, token_hash, created_at, kind, session_id) VALUES (?, ?, ?, ?, 'session', ?)").run(id, v.name, hash, new Date().toISOString(), sessionId);
  const ins = db.prepare("INSERT INTO scopes (token_id, space, project, section, permission) VALUES (?, ?, ?, ?, ?)");
  for (const s of v.scopes) ins.run(id, s.space, s.project, s.section, s.permission);
  return { id, name: v.name, scopes: v.scopes };
}
