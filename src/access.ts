// Access requests raised by token-less sessions (kb_request_access) and their review by the
// admin (web UI / CLI). Approval turns a request into a session grant (see auth/sessions.ts);
// nothing here ever touches the vault.
import { randomInt, randomUUID } from "node:crypto";
import { db } from "./db";
import { Scope } from "./auth/types";
import { clientSlug, insertGrant, listGrants } from "./auth/sessions";
import { TokenValidationError, validateTokenInput } from "./auth/tokens";
import { dropRedundantScopes, formatScope, wildcardWarnings } from "./cli/token";
import { safeAudit } from "./tools/common";
import { isValidSlug } from "./vault/paths";

export const MAX_REASON_CHARS = 500;
export const ACCESS_KINDS = ["read", "write"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];
// No 0/O/1/I/L: the code is read aloud / compared by eye.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

export class AccessError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 429,
    message: string,
    readonly lines: string[] = [],
  ) {
    super(message);
    this.name = "AccessError";
  }
}

const posInt = (v: string | undefined, d: number): number => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function accessLimits(env: NodeJS.ProcessEnv = process.env): { perSession: number; total: number; ttlMs: number } {
  return {
    perSession: posInt(env.ACCESS_MAX_PENDING_PER_SESSION, 3),
    total: posInt(env.ACCESS_MAX_PENDING_TOTAL, 20),
    ttlMs: posInt(env.ACCESS_REQUEST_TTL_MINUTES, 15) * 60_000,
  };
}

// What approving `access` on space/project grants by default: the shared `meta` space read-only
// plus that project (same shape as preset `project`, but `meta` itself may be requested).
export function defaultAccessScopes(space: string, project: string, access: AccessKind): Scope[] {
  const s: Scope[] = [
    { space: "meta", project: "*", section: "*", permission: "read" },
    { space, project, section: "*", permission: "read" },
  ];
  if (access === "write") s.push({ space, project, section: "*", permission: "write" });
  return s;
}

export interface RequestRow {
  id: string;
  code: string;
  session_id: string;
  space: string;
  project: string;
  access: AccessKind;
  reason: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  token_id: string | null;
  scopes: string | null; // JSON Scope[] when the agent asked for an explicit list
  elevation: number; // 1 when the session already held a grant at request time
}

export const requestedScopes = (r: Pick<RequestRow, "scopes">): Scope[] | undefined => (r.scopes ? (JSON.parse(r.scopes) as Scope[]) : undefined);

const isLive = (r: RequestRow, now = Date.now()): boolean => r.status === "pending" && Date.parse(r.expires_at) > now;

function newCode(): string {
  for (let i = 0; i < 20; i++) {
    let c = "";
    for (let j = 0; j < CODE_LEN; j++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const clash = db.prepare("SELECT 1 FROM access_requests WHERE code = ? AND status = 'pending' AND expires_at > ?").get(c, new Date().toISOString());
    if (!clash) return c;
  }
  throw new Error("cannot generate a unique access code");
}

export interface NewRequest {
  space: string;
  project: string;
  access: string;
  reason: string;
  scopes?: unknown; // optional explicit "space:project:section:permission" list
}

// Validates and records a pending request bound to `sessionId`. An identical pending request of the
// same session is returned as is (a retrying agent does not burn its quota). `allow` is the per-IP
// budget, consulted only when a new row would be created. Messages are client-safe.
export function createAccessRequest(sessionId: string, input: NewRequest, allow: () => boolean = () => true): { request: RequestRow; created: boolean } {
  if (!isValidSlug(input.space) || !isValidSlug(input.project)) throw new AccessError(400, "Invalid space/project name (lowercase a-z, 0-9, hyphen).");
  if (!(ACCESS_KINDS as readonly string[]).includes(input.access)) throw new AccessError(400, 'access must be "read" or "write".');
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON_CHARS) throw new AccessError(400, `reason must be 1-${MAX_REASON_CHARS} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reason.replace(/\n/g, " "))) throw new AccessError(400, "reason must not contain control characters.");
  let explicit: Scope[] | undefined;
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.length > 10 || input.scopes.some((x) => typeof x !== "string")) {
      throw new AccessError(400, "scopes must be 1-10 strings of the form space:project:section:permission.");
    }
    try {
      explicit = validateTokenInput("x", (input.scopes as string[]).map((x) => {
        const p = x.split(":");
        if (p.length !== 4) throw new TokenValidationError(`invalid scope ${JSON.stringify(x.slice(0, 80))}, expected space:project:section:permission`);
        return { space: p[0], project: p[1], section: p[2], permission: p[3] as Scope["permission"] };
      })).scopes;
    } catch (err) {
      if (err instanceof TokenValidationError) throw new AccessError(400, err.message);
      throw err;
    }
  }
  const { perSession, total, ttlMs } = accessLimits();

  return db.transaction(() => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const mine = db
      .prepare("SELECT * FROM access_requests WHERE session_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at")
      .all(sessionId, nowIso) as unknown as RequestRow[];
    const scopesJson = explicit ? JSON.stringify(explicit) : null;
    const same = mine.find((r) => r.space === input.space && r.project === input.project && r.access === input.access && r.scopes === scopesJson);
    if (same) return { request: same, created: false };
    if (mine.length >= perSession) throw new AccessError(429, `Too many pending access requests for this session (max ${perSession}). Ask the user to resolve them first.`);
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending' AND expires_at > ?").get(nowIso) as { n: number }).n;
    if (pending >= total) throw new AccessError(429, "Too many pending access requests. Ask the user to review them in the admin web.");
    if (!allow()) throw new AccessError(429, "Too many access requests from this address, retry later.");
    const row: RequestRow = {
      id: randomUUID(),
      code: newCode(),
      session_id: sessionId,
      space: input.space,
      project: input.project,
      access: input.access as AccessKind,
      reason,
      status: "pending",
      created_at: nowIso,
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      decided_at: null,
      decided_by: null,
      token_id: null,
      scopes: scopesJson,
      elevation: listGrants(sessionId).length > 0 ? 1 : 0,
    };
    db.prepare(
      "INSERT INTO access_requests (id, code, session_id, space, project, access, reason, status, created_at, expires_at, scopes, elevation) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    ).run(row.id, row.code, row.session_id, row.space, row.project, row.access, row.reason, row.created_at, row.expires_at, row.scopes, row.elevation);
    if (row.elevation) audit(`session:${sessionId}`, "access_elevation_request", row, "ok", `${row.access} code ${row.code}`);
    return { request: row, created: true };
  })();
}

export interface AccessStatus {
  status: "pending" | "approved" | "denied" | "expired" | "revoked";
  scopes?: Scope[];
}

// Only the requesting session can read its own request (null = unknown to this session).
export function accessStatus(sessionId: string, requestId: string): AccessStatus | null {
  const r = db.prepare("SELECT * FROM access_requests WHERE id = ? AND session_id = ?").get(requestId, sessionId) as unknown as RequestRow | undefined;
  if (!r) return null;
  if (r.status === "denied") return { status: "denied" };
  if (r.status === "approved") {
    const g = listGrants(sessionId).find((x) => x.tokenId === r.token_id);
    return g ? { status: "approved", scopes: g.scopes } : { status: "revoked" };
  }
  return { status: isLive(r) ? "pending" : "expired" };
}

export interface PendingRequest extends RequestRow {
  client_name: string;
  client_version: string;
  remote_ip: string | null;
  // What the session already holds (empty for a first request); requested = scopes asked for.
  current_grants: Array<{ name: string; scopes: Scope[] }>;
  requested_scopes: Scope[];
}

export function listPendingRequests(): PendingRequest[] {
  const rows = db
    .prepare(
      `SELECT r.*, s.client_name, s.client_version, s.remote_ip FROM access_requests r JOIN sessions s ON s.id = r.session_id
       WHERE r.status = 'pending' AND r.expires_at > ? AND s.revoked_at IS NULL ORDER BY r.created_at`,
    )
    .all(new Date().toISOString()) as unknown as PendingRequest[];
  return rows.map((r) => ({
    ...r,
    current_grants: listGrants(r.session_id).map((g) => ({ name: g.name, scopes: g.scopes })),
    requested_scopes: requestedScopes(r) ?? defaultAccessScopes(r.space, r.project, r.access),
  }));
}

export function countPendingRequests(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending' AND expires_at > ?").get(new Date().toISOString()) as { n: number }).n;
}

// `ref` is the request id or its short code (pending requests only for the code).
function findRequest(ref: string): (RequestRow & { client_name: string; session_alive: number }) | undefined {
  const base = `SELECT r.*, s.client_name, (s.id IS NOT NULL AND s.revoked_at IS NULL) AS session_alive
                FROM access_requests r LEFT JOIN sessions s ON s.id = r.session_id`;
  const byId = db.prepare(`${base} WHERE r.id = ?`).get(ref);
  if (byId) return byId as never;
  return db.prepare(`${base} WHERE r.code = ? AND r.status = 'pending' AND r.expires_at > ?`).get(ref.toUpperCase(), new Date().toISOString()) as never;
}

function requireDecidable(ref: string): RequestRow & { client_name: string; session_alive: number } {
  const r = findRequest(ref);
  if (!r) throw new AccessError(404, "access request not found");
  if (r.status !== "pending") throw new AccessError(409, `access request already ${r.status}`);
  if (!isLive(r)) throw new AccessError(409, "access request expired");
  if (!r.session_alive) throw new AccessError(409, "the requesting session is gone");
  return r;
}

export class WildcardConfirmError extends AccessError {
  constructor(lines: string[]) {
    super(422, 'Wildcard scopes grant broad access. Tick "Allow wildcard" to confirm. Nothing was granted.', lines);
  }
}

export interface Decision {
  id: string;
  space: string;
  project: string;
  tokenName: string;
  scopes: Scope[];
  notes: string[];
}

function audit(actor: string, action: string, r: RequestRow, result: "ok" | "error", detail: string): void {
  safeAudit({ tokenId: actor, tokenName: actor, action, space: r.space, project: r.project, result, detail: `${r.id} ${detail}` }, actor);
}

// Approves with `scopes` (default: defaultAccessScopes). Wildcards beyond the defaults need allowWildcard.
export function approveRequest(ref: string, opts: { scopes?: Scope[]; allowWildcard?: boolean; actor: string }): Decision {
  const r = requireDecidable(ref);
  const explicit = requestedScopes(r);
  const defaults = explicit ?? defaultAccessScopes(r.space, r.project, r.access);
  const name = `session-${clientSlug(r.client_name)}-${r.space}-${r.project}`.slice(0, 64).replace(/-+$/, "");
  let validated: { name: string; scopes: Scope[] };
  try {
    validated = validateTokenInput(name, opts.scopes ?? defaults);
  } catch (err) {
    if (err instanceof TokenValidationError || (err instanceof Error && /^invalid scope/.test(err.message))) throw new AccessError(422, err.message);
    throw err;
  }
  const { kept, dropped } = dropRedundantScopes(validated.scopes);
  // The default shape is pre-confirmed; an explicit agent-requested list never is.
  const own = explicit ? [] : defaults.map(formatScope);
  const warnings = wildcardWarnings(kept.filter((s) => !own.includes(formatScope(s))));
  if (warnings.length > 0 && !opts.allowWildcard) throw new WildcardConfirmError(warnings);
  const grant = db.transaction(() => {
    // Re-check inside the write lock: a concurrent decision must win exactly once.
    const cur = db.prepare("SELECT status FROM access_requests WHERE id = ?").get(r.id) as { status: string } | undefined;
    if (cur?.status !== "pending") throw new AccessError(409, `access request already ${cur?.status ?? "removed"}`);
    const g = insertGrant(r.session_id, validated.name, kept);
    db.prepare("UPDATE access_requests SET status = 'approved', decided_at = ?, decided_by = ?, token_id = ? WHERE id = ?").run(new Date().toISOString(), opts.actor, g.id, r.id);
    return g;
  }).immediate();
  audit(opts.actor, r.elevation ? "access_elevation_approve" : "access_approve", r, "ok", `token ${grant.id} ${grant.name} [${kept.map(formatScope).join(",")}]`);
  return {
    id: r.id,
    space: r.space,
    project: r.project,
    tokenName: grant.name,
    scopes: kept,
    notes: [...warnings, ...dropped.map((s) => `Dropped redundant scope ${formatScope(s)} (already covered by a wildcard scope).`)],
  };
}

export function denyRequest(ref: string, actor: string): { id: string; space: string; project: string } {
  const r = requireDecidable(ref);
  const res = db.prepare("UPDATE access_requests SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(new Date().toISOString(), actor, r.id);
  if (res.changes === 0) throw new AccessError(409, "access request already decided");
  audit(actor, r.elevation ? "access_elevation_deny" : "access_deny", r, "ok", "denied");
  return { id: r.id, space: r.space, project: r.project };
}

// Revoking a session kills all its grants at once (see revokeSession); audited here.
export function auditSessionRevoke(actor: string, sessionId: string, ok: boolean): void {
  safeAudit({ tokenId: actor, tokenName: actor, action: "access_revoke", result: ok ? "ok" : "error", detail: ok ? `session ${sessionId}` : `session ${sessionId} not found or already revoked` }, actor);
}
