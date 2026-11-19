// Shared scan plumbing for kb_backlinks / kb_lint: ACL-filtered note listing and capped reads.
import { Scope } from "../auth/types";
import { listNoteNames, readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath } from "../vault/paths";
import { NoteRef } from "../vault/links";
import { readableSections, ScopeArgs } from "./discovery";

// Mutable so tests can shrink them.
export const scanLimits = {
  maxScannedFiles: 5000,
  maxFileBytes: 1024 * 1024,
  deadlineMs: 3000,
  maxTotalBytes: 20 * 1024 * 1024,
};

export class ScanBudget {
  skipped = 0;
  truncated: string | undefined;
  private started = Date.now();
  private scanned = 0;
  private bytes = 0;

  constructor(private vaultRoot: string) {}

  // Sets `truncated` and returns true once a cap is hit.
  exhausted(): boolean {
    if (this.truncated === undefined) {
      if (Date.now() - this.started >= scanLimits.deadlineMs) this.truncated = "time limit reached";
      else if (this.bytes >= scanLimits.maxTotalBytes) this.truncated = "read limit reached";
      else if (this.scanned >= scanLimits.maxScannedFiles) this.truncated = "too many notes";
    }
    return this.truncated !== undefined;
  }

  // undefined when a cap is hit (check `truncated`) or the note is unreadable or oversized (counted in `skipped`).
  async read(n: NoteRef): Promise<string | undefined> {
    if (this.exhausted()) return undefined;
    this.scanned++;
    try {
      const r = await readFileNoFollow(resolveNotePath(this.vaultRoot, n.space, n.project, n.section, n.name), scanLimits.maxFileBytes);
      if (!r) {
        this.skipped++;
        return undefined;
      }
      this.bytes += r.bytes;
      return r.content;
    } catch {
      this.skipped++;
      return undefined;
    }
  }
}

// Notes of the sections this token can read (ACL applied before any directory is listed).
export async function listReadableNotes(
  vaultRoot: string,
  scopes: Scope[],
  filter: ScopeArgs,
  includeArchived: boolean,
  budget: ScanBudget,
): Promise<NoteRef[]> {
  const out: NoteRef[] = [];
  for await (const sec of readableSections(vaultRoot, scopes, filter, includeArchived, budget)) {
    if (budget.exhausted()) break;
    try {
      for (const name of await listNoteNames(vaultRoot, [sec.space, sec.project, sec.section])) out.push({ ...sec, name });
    } catch {
      budget.skipped++;
    }
  }
  return out;
}

export function scanNotice(budget: ScanBudget): string {
  return (
    (budget.truncated ? `\n(truncated: ${budget.truncated}; results may be incomplete)` : "") +
    (budget.skipped ? `\n(skipped ${budget.skipped} unreadable or oversized entries)` : "")
  );
}
