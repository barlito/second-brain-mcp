// Audit of failed authentications, shared by the Bearer and connector-key paths. Per-client coalescing
// lives in the callers' limiters; this adds a global per-minute cap so many clients cannot flood the log.
import { logAuthFailure } from "./audit";
import { GlobalBudget } from "./rateLimit";
import { redact } from "./vault/git";

const n = Number(process.env.AUTH_AUDIT_MAX_PER_MIN);
export const authAuditBudget = new GlobalBudget(Number.isInteger(n) && n > 0 ? n : 30);

export function auditAuthFailure(clientIp: string | undefined, reason: string): void {
  const b = authAuditBudget.take();
  try {
    if (b.summary > 0) logAuthFailure({ reason: `${b.summary} further auth failures not logged (per-minute audit cap)` });
    if (b.log) logAuthFailure({ clientIp, reason });
  } catch (err) {
    // A DB failure here must still yield a 401.
    console.error("auth failure audit write failed:", redact(String(err)));
  }
}
