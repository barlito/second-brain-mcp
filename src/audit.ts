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

export interface AuditRow {
  id: number;
  ts: string;
  token_name: string | null;
  action: string;
  space: string | null;
  project: string | null;
  section: string | null;
  note: string | null;
  result: string;
  detail: string | null;
  git_commit: string | null;
  client_ip: string | null;
}

export const AUDIT_PAGE_SIZE = 50;

// Newest first, keyset-paginated on id: one extra row tells whether another page exists.
export function queryAudit(f: { before?: number; tokenName?: string; action?: string }): {
  rows: AuditRow[];
  nextBefore: number | null;
} {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.before !== undefined) {
    where.push("id < ?");
    args.push(f.before);
  }
  if (f.tokenName !== undefined) {
    where.push("token_name = ?");
    args.push(f.tokenName);
  }
  if (f.action !== undefined) {
    where.push("action = ?");
    args.push(f.action);
  }
  const rows = db
    .prepare(
      `SELECT id, ts, token_name, action, space, project, section, note, result, detail, git_commit, client_ip
       FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, AUDIT_PAGE_SIZE + 1) as unknown as AuditRow[];
  const more = rows.length > AUDIT_PAGE_SIZE;
  const page = more ? rows.slice(0, AUDIT_PAGE_SIZE) : rows;
  return { rows: page, nextBefore: more ? page[page.length - 1].id : null };
}
