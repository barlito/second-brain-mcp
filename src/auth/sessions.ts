// Server-issued MCP sessions for clients that connect without a Bearer token. The transport
// stays stateless; a session only identifies a client across requests so that an admin-approved
// access request can be bound to it. The secret Mcp-Session-Id is stored hashed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../db";
import { SessionGrant } from "./context";
import { Scope } from "./types";
import { validateTokenInput } from "./tokens";
import { anonLimits, ipKey } from "../rateLimit";

export const NOGRANT_IDLE_MS = 60 * 60_000;
const LAST_SEEN_THROTTLE_MS = 60_000;
const DAY_MS = 86_400_000;

// SESSION_IDLE_DAYS: sliding idle expiry of a session that holds grants (default 1, i.e. 24 h).
export function sessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SESSION_IDLE_DAYS);
  return Number.isFinite(n) && n > 0 ? n * DAY_MS : 1 * DAY_MS;
}

// SESSION_MAX_DAYS: absolute lifetime of a session from its first grant (default 30), on top of the idle expiry.
export function sessionMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SESSION_MAX_DAYS);
  return Number.isFinite(n) && n > 0 ? n * DAY_MS : 30 * DAY_MS;
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
  ip_key: string | null;
  connector_key_id: string | null;
  created_at: string;
  last_seen_at: string;
  first_grant_at: string | null;
  revoked_at: string | null;
}

const insertSession = db.prepare(
  "INSERT INTO sessions (id, sid_hash, client_name, client_version, remote_ip, ip_key, connector_key_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const selectByHash = db.prepare("SELECT * FROM sessions WHERE sid_hash = ?");
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?");
const selectGrantTokens = db.prepare(
  "SELECT id, name FROM tokens WHERE session_id = ? AND kind = 'session' AND revoked_at IS NULL ORDER BY created_at, rowid",
);
const selectScopes = db.prepare("SELECT space, project, section, permission FROM scopes WHERE token_id = ?");

export function createSession(input: { clientName: unknown; clientVersion: unknown; ip?: string; connectorKeyId?: string }): { sid: string; id: string } {
  const sid = randomBytes(32).toString("hex");
  const id = randomUUID();
  const now = new Date().toISOString();
  insertSession.run(id, hashSid(sid), cleanText(input.clientName, 64, "unknown"), cleanText(input.clientVersion, 32, "?"), input.ip ?? null, ipKey(input.ip), input.connectorKeyId ?? null, now, now);
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
  connectorKeyId: string | null;
  grants: SessionGrant[];
}

// Expiry rules: with grants, idle longer than SESSION_IDLE_DAYS (sliding) or older than SESSION_MAX_DAYS
// since the first grant (absolute); without grants, idle longer than 1 h or older than the grantless
// absolute lifetime (ANON_SESSION_MAX_HOURS), so polling never keeps a useless session alive.
function isExpired(row: SessionRow, hasGrant: boolean, now: number, env?: NodeJS.ProcessEnv): boolean {
  const last = Date.parse(row.last_seen_at);
  const ttl = hasGrant ? sessionIdleMs(env) : NOGRANT_IDLE_MS;
  // last > now (clock stepped back) is not expiry.
  if (Number.isNaN(last) || now - last >= ttl) return true;
  if (hasGrant) {
    const g = Date.parse(row.first_grant_at ?? row.created_at);
    return Number.isNaN(g) || now - g >= sessionMaxMs(env);
  }
  const c = Date.parse(row.created_at);
  return Number.isNaN(c) || now - c >= anonLimits(env).grantlessMaxMs;
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
  return { id: row.id, clientName: row.client_name, clientVersion: row.client_version, connectorKeyId: row.connector_key_id, grants };
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

const GRANTLESS_SQL = `FROM sessions s WHERE revoked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.session_id = s.id AND t.kind = 'session' AND t.revoked_at IS NULL)`;

// Live sessions without any grant (what an anonymous flood can fill); per (connector key, client) bucket
// when `key` is given, so a leaked key cannot crowd out sessions opened through other keys.
export function countGrantlessSessions(key?: string, connectorKeyId?: string): number {
  const sql = `SELECT COUNT(*) AS n ${GRANTLESS_SQL}${key === undefined ? "" : " AND ip_key = ? AND connector_key_id IS ?"}`;
  const r = db.prepare(sql).get(...(key === undefined ? [] : [key, connectorKeyId ?? null])) as { n: number };
  return r.n;
}

// Frees one slot by ending the most idle grantless session (ones with no pending request first), so
// a flood can never lock legitimate clients out; `key` restricts it to one client.
export function evictGrantlessSession(key?: string, connectorKeyId?: string): boolean {
  const where = key === undefined ? "" : " AND ip_key = ? AND connector_key_id IS ?";
  const row = db
    .prepare(
      `SELECT s.id ${GRANTLESS_SQL}${where}
       ORDER BY EXISTS (SELECT 1 FROM access_requests r WHERE r.session_id = s.id AND r.status = 'pending' AND r.expires_at > ?), s.last_seen_at LIMIT 1`,
    )
    .get(...(key === undefined ? [] : [key, connectorKeyId ?? null]), new Date().toISOString()) as { id: string } | undefined;
  if (!row) return false;
  endSession(row.id);
  return true;
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
  // Dead grant rows (revoked or expired) are kept 30 days for the audit trail, then dropped (scopes cascade).
  db.prepare("DELETE FROM tokens WHERE kind = 'session' AND revoked_at IS NOT NULL AND revoked_at < ?").run(new Date(now - 30 * DAY_MS).toISOString());
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
  connector_key: string | null; // name of the connector key it came through
  expires_at: string; // earliest of sliding idle and absolute end
  grants: Array<{ tokenId: string; name: string; scopes: Scope[] }>;
}

// Sessions that hold at least one active grant (the admin "active sessions" table).
export function listActiveSessions(): ActiveSession[] {
  const rows = db
    .prepare("SELECT s.*, k.name AS key_name FROM sessions s LEFT JOIN connector_keys k ON k.id = s.connector_key_id WHERE s.revoked_at IS NULL ORDER BY s.last_seen_at DESC")
    .all() as Array<SessionRow & { key_name: string | null }>;
  return rows
    .map((r) => ({
      id: r.id,
      client_name: r.client_name,
      client_version: r.client_version,
      remote_ip: r.remote_ip,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      connector_key: r.key_name,
      expires_at: new Date(Math.min(Date.parse(r.last_seen_at) + sessionIdleMs(), Date.parse(r.first_grant_at ?? r.created_at) + sessionMaxMs())).toISOString(),
      grants: listGrants(r.id),
    }))
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
  // Starts the absolute lifetime clock on the first grant only.
  db.prepare("UPDATE sessions SET first_grant_at = COALESCE(first_grant_at, ?) WHERE id = ?").run(new Date().toISOString(), sessionId);
  return { id, name: v.name, scopes: v.scopes };
}

export interface ReleaseResult {
  released: Scope[];
  notHeld: Scope[];
  revokedGrants: number;
}

// Agent-side give-back. Only touches grant tokens (kind='session') of `sessionId`, never other
// sessions or Bearer tokens. Without `scopes`: revokes every active grant. With `scopes`: deletes the
// exactly matching scope rows (no wildcard expansion); a grant left with no scope is revoked, like an
// admin revoke. The session itself stays alive (baseline scopes are not grants).
export function releaseGrants(sessionId: string, scopes?: Scope[]): ReleaseResult {
  const key = (s: Scope): string => `${s.space}:${s.project}:${s.section}:${s.permission}`;
  return db.transaction(() => {
    const at = new Date().toISOString();
    const grants = listGrants(sessionId);
    const revoke = db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND session_id = ? AND kind = 'session' AND revoked_at IS NULL");
    if (!scopes) {
      const held = new Map<string, Scope>();
      for (const g of grants) {
        for (const s of g.scopes) held.set(key(s), s);
        revoke.run(at, g.tokenId, sessionId);
      }
      return { released: [...held.values()], notHeld: [], revokedGrants: grants.length };
    }
    const del = db.prepare("DELETE FROM scopes WHERE token_id = ? AND space = ? AND project = ? AND section = ? AND permission = ?");
    const released: Scope[] = [];
    const notHeld: Scope[] = [];
    const touched = new Set<string>();
    for (const want of scopes) {
      let hit = false;
      for (const g of grants) {
        if (del.run(g.tokenId, want.space, want.project, want.section, want.permission).changes > 0) {
          hit = true;
          touched.add(g.tokenId);
        }
      }
      (hit ? released : notHeld).push(want);
    }
    let revokedGrants = 0;
    for (const id of touched) {
      const left = db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE token_id = ?").get(id) as { n: number };
      if (left.n === 0) revokedGrants += revoke.run(at, id, sessionId).changes;
    }
    return { released, notHeld, revokedGrants };
  })();
}
