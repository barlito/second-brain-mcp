import { db } from "./db";

export interface AuditEntry {
  tokenId?: string | null;
  tokenName?: string | null;
  action: string;
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
  `INSERT INTO audit_log (ts, token_id, token_name, action, project, section, note, result, detail, git_commit, client_ip)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const pruneAuditStmt = db.prepare("DELETE FROM audit_log WHERE ts < ?");

export function logAudit(entry: AuditEntry): void {
  insertAuditStmt.run(
    new Date().toISOString(),
    entry.tokenId ?? null,
    cap(entry.tokenName),
    cap(entry.action),
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
  logAudit({
    action: "auth",
    result: "denied",
    clientIp: opts.clientIp,
    detail: opts.reason,
  });
}

// Deletes audit rows older than N days; returns the number deleted.
export function pruneAudit(olderThanDays: number): number {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error("olderThanDays must be a non-negative number");
  }
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  return pruneAuditStmt.run(cutoff).changes;
}
