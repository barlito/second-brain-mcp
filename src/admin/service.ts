// Inbox operations shared by the loopback listener (CLI) and the web admin UI.
// Pure functions of (vaultRoot, actor): no HTTP concerns. Failures that map to a client
// status are thrown as AdminError; anything else propagates (callers log it generically).
import {
  assertInboxDirSafe,
  HEAD_BYTES,
  inboxPath,
  listHeads,
  MAX_ADMIN_READ_BYTES,
  parseProposal,
  parseProposalHead,
  Proposal,
  readBounded,
  splitTarget,
} from "../inbox";
import { isValidSlug, resolveNotePath } from "../vault/paths";
import { InboxInvalidError, InboxMissingError, NoteExistsError, redact, syncInboxResolve } from "../vault/git";
import { errorMessage, MAX_CONTENT_CHARS, safeAudit } from "../tools/common";
import { NoteRuleError, validateNoteContent } from "../tools/conventions";
import { assertSpaceLimits } from "../limits";
import { rejectReservedSection } from "../tools/reserved";

export const CLI_ACTOR = "admin-cli";

export class AdminError extends Error {
  constructor(
    readonly status: 404 | 409 | 413 | 422,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export interface InboxListItem {
  id: string;
  target: string | null;
  proposed_by: string | null;
  reason: string | null;
  created: string | null;
  size: number;
}

export async function listInbox(vaultRoot: string): Promise<{ proposals: InboxListItem[]; truncated: boolean }> {
  const { items, truncated } = await listHeads(vaultRoot);
  return {
    proposals: items.map(({ id, head, size }) => ({
      id,
      target: head?.target ?? null,
      proposed_by: head?.proposedBy ?? null,
      reason: head?.reason ?? null,
      created: head?.created ?? null,
      size,
    })),
    truncated,
  };
}

export type ShownProposal = Omit<Proposal, "proposedBy"> & { proposed_by: string; size: number };

// The inbox dir is checked first so a symlinked dir is never followed; the file itself
// is opened O_NOFOLLOW.
export async function showProposal(vaultRoot: string, id: string): Promise<ShownProposal> {
  assertInboxDirSafe(vaultRoot);
  let r;
  try {
    r = await readBounded(inboxPath(vaultRoot, id), MAX_ADMIN_READ_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") throw new AdminError(404, "proposal not found");
    throw err;
  }
  if (!r) throw new AdminError(404, "proposal not found");
  if (r.truncated) throw new AdminError(413, "proposal too large to show; reject it");
  const p = parseProposal(id, r.text);
  if (!p) throw new AdminError(422, "malformed proposal file");
  const { proposedBy, ...rest } = p;
  return { ...rest, proposed_by: proposedBy, size: r.size };
}

function audit(actor: string, action: string, id: string, p: { target: string }, result: "ok" | "error", detail: string, gitCommit?: string): void {
  const t = splitTarget(p.target);
  safeAudit({ tokenId: actor, tokenName: actor, action, ...(t ?? {}), result, detail: `${id} ${detail}`, gitCommit }, actor);
}

// Same rules kb_write applies, on what is about to be accepted. Throws on violation.
function validateAccept(raw: Buffer, id: string): { p: Proposal; t: NonNullable<ReturnType<typeof splitTarget>> } {
  if (raw.length > MAX_ADMIN_READ_BYTES) throw new InboxInvalidError("proposal file too large");
  const p = parseProposal(id, raw.toString("utf8"));
  if (!p) throw new InboxInvalidError("malformed proposal file");
  const t = splitTarget(p.target);
  if (!t || ![t.space, t.project, t.section, t.note].every(isValidSlug)) {
    throw new InboxInvalidError("proposal has an invalid target");
  }
  const reserved = rejectReservedSection(t.section);
  if (reserved) throw new InboxInvalidError((reserved.toolResult.content[0] as { text: string }).text);
  if (p.content.length > MAX_CONTENT_CHARS) throw new InboxInvalidError("content too large (max 512 KB)");
  validateNoteContent(t, p.content);
  return { p, t };
}

export interface ResolveResult {
  id: string;
  target: string;
  commit: string | null;
}

// Load, parse and validate INSIDE the write lock (after the pull), so exactly what is
// validated is what gets committed.
export async function acceptProposal(vaultRoot: string, id: string, overwrite: boolean, actor: string): Promise<ResolveResult> {
  let seen: { target: string } = { target: "(unknown)" };
  try {
    const { commitSha } = await syncInboxResolve(vaultRoot, inboxPath(vaultRoot, id), (raw) => {
      const { p, t } = validateAccept(raw, id);
      seen = p;
      // accept.content below is what gets written, so it is what is measured.
      assertSpaceLimits(vaultRoot, t, Buffer.byteLength(p.content, "utf8"));
      return {
        message: `inbox accept: ${p.target} (proposed by ${p.proposedBy})`,
        accept: {
          targetAbs: resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note),
          content: p.content,
          overwrite,
        },
      };
    });
    audit(actor, "inbox_accept", id, seen, "ok", overwrite ? "overwrite" : "create", commitSha ?? undefined);
    return { id, target: seen.target, commit: commitSha ?? null };
  } catch (err) {
    if (err instanceof NoteExistsError) {
      audit(actor, "inbox_accept", id, seen, "error", "target exists");
      throw new AdminError(409, "target note already exists (use overwrite)");
    }
    if (err instanceof InboxMissingError) throw new AdminError(404, "proposal not found");
    if (err instanceof InboxInvalidError || err instanceof NoteRuleError) {
      audit(actor, "inbox_accept", id, seen, "error", err.message);
      throw new AdminError(422, err.message);
    }
    audit(actor, "inbox_accept", id, seen, "error", redact(errorMessage(err)));
    throw err;
  }
}

export async function rejectProposal(vaultRoot: string, id: string, actor: string): Promise<ResolveResult> {
  let seen: { target: string } = { target: "(unknown)" };
  try {
    const { commitSha } = await syncInboxResolve(vaultRoot, inboxPath(vaultRoot, id), (raw) => {
      // A malformed file can still be rejected (removed); only the head is parsed.
      const h = parseProposalHead(id, raw.subarray(0, HEAD_BYTES).toString("utf8"));
      seen = { target: h?.target ?? "(malformed)" };
      return { message: `inbox reject: ${seen.target} (proposed by ${h?.proposedBy ?? "unknown"})` };
    });
    audit(actor, "inbox_reject", id, seen, "ok", "rejected", commitSha ?? undefined);
    return { id, target: seen.target, commit: commitSha ?? null };
  } catch (err) {
    if (err instanceof InboxMissingError) throw new AdminError(404, "proposal not found");
    audit(actor, "inbox_reject", id, seen, "error", redact(errorMessage(err)));
    throw err;
  }
}
