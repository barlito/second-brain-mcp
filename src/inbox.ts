// Inbox proposal files: inbox/<id>.md = YAML frontmatter + proposed note content.
// Shared by kb_propose (writer) and the admin listener (reader). Frontmatter values
// are JSON strings (valid YAML), so free text can never break the format.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { INBOX_SPACE } from "./acl/check";

export const INBOX_DIR = INBOX_SPACE;
export const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const MAX_REASON_CHARS = 500;

export interface Proposal {
  id: string;
  target: string; // space/project/section/note
  proposedBy: string;
  reason: string;
  created: string;
  content: string;
}

export function isValidInboxId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function newInboxId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

export function inboxPath(vaultRoot: string, id: string): string {
  if (!isValidInboxId(id)) throw new Error("invalid inbox id");
  return path.join(path.resolve(vaultRoot), INBOX_DIR, `${id}.md`);
}

export function serializeProposal(p: Omit<Proposal, "id">): string {
  const j = JSON.stringify;
  return `---\ntarget: ${j(p.target)}\nproposed_by: ${j(p.proposedBy)}\nreason: ${j(p.reason)}\ncreated: ${j(p.created)}\n---\n\n${p.content}`;
}

function val(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (typeof v === "string") return v;
  } catch {
    /* hand-edited plain scalar */
  }
  return raw.trim();
}

// Returns null when the file has no frontmatter or no valid target.
export function parseProposal(id: string, raw: string): Proposal | null {
  const m = /^---\n([\s\S]*?)\n---\n\n?/.exec(raw);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = val(line.slice(i + 1).trim());
  }
  if (!fm.target) return null;
  // serializeProposal puts exactly one blank line after the fence; the regex ate it.
  return {
    id,
    target: fm.target,
    proposedBy: fm.proposed_by ?? "",
    reason: fm.reason ?? "",
    created: fm.created ?? "",
    content: raw.slice(m[0].length),
  };
}

// "space/project/section/note" -> parts, or null if not exactly four parts.
export function splitTarget(target: string): { space: string; project: string; section: string; note: string } | null {
  const p = target.split("/");
  if (p.length !== 4) return null;
  return { space: p[0], project: p[1], section: p[2], note: p[3] };
}
