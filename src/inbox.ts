// Inbox proposal files: _inbox/<id>.md = YAML frontmatter + proposed note content.
// Shared by kb_propose (writer) and the admin listener (reader). Frontmatter values
// are JSON strings (valid YAML), so free text can never break the format.
import { randomBytes } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
import path from "node:path";
import { assertSafePath } from "./vault/paths";

// Top-level vault dir for pending proposals. The leading "_" makes it fail the slug
// regex, so it can never be a space/project/section/note and enumeration skips it.
export const INBOX_DIR = "_inbox";
export const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const MAX_REASON_CHARS = 500;
// kb_propose refuses a final file (frontmatter + content) above this many UTF-8 bytes:
// 512 KiB of content plus headroom, safely under the admin reader's cap.
export const MAX_PROPOSAL_FILE_BYTES = 576 * 1024;
export const MAX_ADMIN_READ_BYTES = 1024 * 1024;
// Bytes read per file when only the frontmatter is needed (list, quota count).
export const HEAD_BYTES = 4096;
export const MAX_LIST = 500;
const LIST_CONCURRENCY = 8;

export class InboxFullError extends Error {
  constructor() {
    super("too many pending proposals; ask the user to review the inbox");
    this.name = "InboxFullError";
  }
}

export function inboxLimits(env: NodeJS.ProcessEnv = process.env): { perToken: number; total: number } {
  const n = (v: string | undefined, d: number): number => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { perToken: n(env.INBOX_MAX_PER_TOKEN, 20), total: n(env.INBOX_MAX_TOTAL, 200) };
}

export interface Proposal {
  id: string;
  target: string; // space/project/section/note
  proposedBy: string;
  reason: string;
  created: string;
  content: string;
}

export type ProposalHead = Omit<Proposal, "content">;

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

// Frontmatter only (a bounded head of the file is enough).
export function parseProposalHead(id: string, head: string): ProposalHead | null {
  const p = parseProposal(id, head);
  if (!p) return null;
  const { content: _content, ...rest } = p;
  return rest;
}

// "space/project/section/note" -> parts, or null if not exactly four parts.
export function splitTarget(target: string): { space: string; project: string; section: string; note: string } | null {
  const p = target.split("/");
  if (p.length !== 4) return null;
  return { space: p[0], project: p[1], section: p[2], note: p[3] };
}

// Real directory inside the vault (no symlinked component); throws UnsafePathError otherwise.
export function assertInboxDirSafe(vaultRoot: string): string {
  const dir = path.join(path.resolve(vaultRoot), INBOX_DIR);
  assertSafePath(vaultRoot, dir);
  return dir;
}

// Sorted ids of the proposal files in the inbox dir ([] when it does not exist).
export async function listInboxIds(vaultRoot: string): Promise<string[]> {
  const dir = assertInboxDirSafe(vaultRoot);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(".md") && ID_RE.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort();
}

// Reads at most maxBytes of a regular file through one O_NOFOLLOW fd. Undefined if it is
// not a regular file; `truncated` says the file is larger than maxBytes.
export async function readBounded(
  file: string,
  maxBytes: number,
): Promise<{ text: string; size: number; truncated: boolean } | undefined> {
  const fh = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return { text: buf.subarray(0, off).toString("utf8"), size: st.size, truncated: st.size > maxBytes };
  } finally {
    await fh.close();
  }
}

// Frontmatter of one proposal; undefined when unreadable or vanished.
async function readHead(vaultRoot: string, id: string): Promise<{ head: ProposalHead | null; size: number } | undefined> {
  try {
    const r = await readBounded(inboxPath(vaultRoot, id), HEAD_BYTES);
    return r ? { head: parseProposalHead(id, r.text), size: r.size } : undefined;
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function listHeads(
  vaultRoot: string,
  max = MAX_LIST,
): Promise<{ items: Array<{ id: string; head: ProposalHead | null; size: number }>; truncated: boolean }> {
  const ids = await listInboxIds(vaultRoot);
  const rows = await mapLimit(ids.slice(0, max), LIST_CONCURRENCY, async (id) => ({ id, r: await readHead(vaultRoot, id) }));
  const items = rows.flatMap((x) => (x.r ? [{ id: x.id, head: x.r.head, size: x.r.size }] : []));
  return { items, truncated: ids.length > max };
}

// Refuses when the total or this proposer's share of pending proposals hit the caps.
// Call under the write lock so concurrent proposals cannot slip past the caps.
export async function assertInboxQuota(vaultRoot: string, proposer: string): Promise<void> {
  const { perToken, total } = inboxLimits();
  const ids = await listInboxIds(vaultRoot);
  if (ids.length >= total) throw new InboxFullError();
  if (ids.length < perToken) return;
  const heads = await mapLimit(ids, LIST_CONCURRENCY, (id) => readHead(vaultRoot, id));
  if (heads.filter((h) => h?.head?.proposedBy === proposer).length >= perToken) throw new InboxFullError();
}
