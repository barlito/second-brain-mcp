import { db } from "./db";

export interface AuditEntry {
  tokenId: string;
  tokenName: string;
  action: string;
  space?: string;
  project?: string;
  section?: string;
  note?: string;
  result: "ok" | "denied" | "error";
  detail?: string;
  gitCommit?: string;
  clientIp?: string;
}

// Caps attacker-controllable free text so it can't bloat the DB.
export const MAX_FIELD_LEN = 256;

function cap(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.length > MAX_FIELD_LEN ? v.slice(0, MAX_FIELD_LEN) : v;
}

// Prepared once at module load and reused, same pattern as tokens.ts.
const insertAuditStmt = db.prepare(
  `INSERT INTO audit_log (ts, token_id, token_name, action, space, project, section, note, result, detail, git_commit, client_ip)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const MAX_PRUNE_DAYS = 36500;
const pruneAuditStmt = db.prepare("DELETE FROM audit_log WHERE ts < ?");

export function logAudit(entry: AuditEntry): void {
  write(entry);
}

// Internal: only logAuthFailure may pass a null identity.
function write(
  entry: Omit<AuditEntry, "tokenId" | "tokenName"> & { tokenId: string | null; tokenName: string | null },
): void {
  insertAuditStmt.run(
    new Date().toISOString(),
    entry.tokenId,
    cap(entry.tokenName),
    cap(entry.action),
    cap(entry.space),
    cap(entry.project),
    cap(entry.section),
    cap(entry.note),
    entry.result,
    cap(entry.detail),
    cap(entry.gitCommit),
    cap(entry.clientIp),
  );
}

// Records a failed authentication attempt (no token identity).
export function logAuthFailure(opts: { clientIp?: string; reason: string }): void {
  write({
    tokenId: null,
    tokenName: null,
    action: "auth",
    result: "denied",
    clientIp: opts.clientIp,
    detail: opts.reason,
  });
}

// Deletes audit rows older than N days; returns the number deleted.
export function pruneAudit(olderThanDays: number): number {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || olderThanDays > MAX_PRUNE_DAYS) {
    throw new Error(`olderThanDays must be between 0 and ${MAX_PRUNE_DAYS}`);
  }
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  return pruneAuditStmt.run(cutoff).changes;
}
