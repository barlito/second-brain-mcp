import { db } from "./db";

export interface AuditEntry {
  tokenId: string;
  tokenName: string;
  action: string;
  project?: string;
  section?: string;
  note?: string;
  result: "ok" | "denied" | "error";
  detail?: string;
  gitCommit?: string;
}

// Prepared once at module load and reused, same pattern as tokens.ts.
const insertAuditStmt = db.prepare(
  `INSERT INTO audit_log (ts, token_id, token_name, action, project, section, note, result, detail, git_commit)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function logAudit(entry: AuditEntry): void {
  insertAuditStmt.run(
    new Date().toISOString(),
    entry.tokenId,
    entry.tokenName,
    entry.action,
    entry.project ?? null,
    entry.section ?? null,
    entry.note ?? null,
    entry.result,
    entry.detail ?? null,
    entry.gitCommit ?? null,
  );
}
