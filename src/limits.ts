// Per-space limits (SPACE_LIMITS): caps applied per project inside a configured space.
// Counted over every section except `archive`, checked inside the write lock.
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isValidSlug, resolveNotePath } from "./vault/paths";
import { NoteRuleError } from "./tools/conventions";
import { ARCHIVE_SECTION } from "./tools/reserved";

export interface SpaceLimits {
  maxNotes?: number;
  maxNoteBytes?: number;
  maxProjectBytes?: number;
  archiveAfterDays?: number;
}

const KEYS: ReadonlyArray<keyof SpaceLimits> = ["maxNotes", "maxNoteBytes", "maxProjectBytes", "archiveAfterDays"];
const MAX_VALUE = 1_000_000_000;

// Format: `space:key=value,key=value;space2:key=value`. Throws on anything malformed so a
// typo fails the boot instead of silently disabling a limit.
export function parseSpaceLimits(raw: string | undefined): Map<string, SpaceLimits> {
  const out = new Map<string, SpaceLimits>();
  const text = (raw ?? "").trim();
  if (!text) return out;
  for (const part of text.split(";")) {
    const entry = part.trim();
    if (!entry) continue; // tolerate a trailing ";"
    const colon = entry.indexOf(":");
    if (colon < 0) throw new Error(`SPACE_LIMITS: "${entry}" must look like space:key=value,key=value`);
    const space = entry.slice(0, colon).trim();
    if (!isValidSlug(space)) throw new Error(`SPACE_LIMITS: invalid space name "${space}"`);
    if (out.has(space)) throw new Error(`SPACE_LIMITS: space "${space}" is listed twice`);
    const limits: SpaceLimits = {};
    for (const kv of entry.slice(colon + 1).split(",")) {
      const pair = kv.trim();
      if (!pair) continue;
      const [key, value, ...extra] = pair.split("=").map((s) => s.trim());
      if (!KEYS.includes(key as keyof SpaceLimits) || value === undefined || extra.length > 0) {
        throw new Error(`SPACE_LIMITS: bad setting "${pair}" for space "${space}" (keys: ${KEYS.join(", ")})`);
      }
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_VALUE) {
        throw new Error(`SPACE_LIMITS: ${space}.${key} must be an integer between 1 and ${MAX_VALUE}, got "${value}"`);
      }
      if (key in limits) throw new Error(`SPACE_LIMITS: ${space}.${key} is set twice`);
      limits[key as keyof SpaceLimits] = Number(value);
    }
    if (Object.keys(limits).length === 0) throw new Error(`SPACE_LIMITS: space "${space}" has no settings`);
    out.set(space, limits);
  }
  return out;
}

// Parsed lazily from the environment (cached per raw value); boot validates it once via parseSpaceLimits.
let cache: { raw: string; parsed: Map<string, SpaceLimits> } | undefined;
export function getSpaceLimits(env: NodeJS.ProcessEnv = process.env): Map<string, SpaceLimits> {
  const raw = env.SPACE_LIMITS ?? "";
  if (cache?.raw !== raw) cache = { raw, parsed: parseSpaceLimits(raw) };
  return cache.parsed;
}

// A NoteRuleError, so every writer already maps it to a client error.
export class SpaceLimitError extends NoteRuleError {
  constructor(
    message: string,
    // Set for the per-note size limit, so callers can word it differently (e.g. template creation).
    readonly noteBytes?: { space: string; bytes: number; limit: number },
  ) {
    super(message, "space limit exceeded");
    this.name = "SpaceLimitError";
  }
}

// Notes (.md regular files) and bytes of a project, `archive` excluded; `existing` is the
// size of the note about to be written (null when it does not exist yet).
function usage(
  vaultRoot: string,
  t: { space: string; project: string; section: string; note: string },
): { notes: number; bytes: number; existing: number | null } {
  const projectDir = path.join(path.resolve(vaultRoot), t.space, t.project);
  const target = resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note);
  let notes = 0;
  let bytes = 0;
  let existing: number | null = null;
  let sections: string[] = [];
  try {
    sections = readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ARCHIVE_SECTION && isValidSlug(e.name))
      .map((e) => e.name);
  } catch {
    /* project does not exist yet */
  }
  for (const s of sections) {
    for (const e of readdirSync(path.join(projectDir, s), { withFileTypes: true })) {
      // Same visibility rule as enumerate.ts: valid-slug .md names only.
      if (!e.name.endsWith(".md") || !isValidSlug(e.name.slice(0, -3))) continue;
      const file = path.join(projectDir, s, e.name);
      const st = lstatSync(file);
      if (!st.isFile()) continue;
      notes++;
      bytes += st.size;
      if (file === target) existing = st.size;
    }
  }
  return { notes, bytes, existing };
}

// Throws SpaceLimitError when writing `newBytes` to the note would break a limit of its space.
// Call inside the write lock. An overwrite counts the new size only, and a write that does not
// grow the project is always allowed on the aggregate limits, so an over-limit project can be condensed.
export function assertSpaceLimits(
  vaultRoot: string,
  t: { space: string; project: string; section: string; note: string },
  newBytes: number,
  // Bytes already added to the project by earlier, not yet written items of a batch (migration).
  pendingBytes = 0,
): void {
  const limits = getSpaceLimits().get(t.space);
  if (!limits || t.section === ARCHIVE_SECTION) return;
  const where = `${t.space}/${t.project}`;
  const hint = "Condense notes or kb_archive old ones first.";
  if (limits.maxNoteBytes !== undefined && newBytes > limits.maxNoteBytes) {
    throw new SpaceLimitError(
      `Note too large for ${t.space}: ${newBytes} bytes (limit ${limits.maxNoteBytes} per note). Make it shorter or split it.`,
      { space: t.space, bytes: newBytes, limit: limits.maxNoteBytes },
    );
  }
  if (limits.maxNotes === undefined && limits.maxProjectBytes === undefined) return;
  const u = usage(vaultRoot, t);
  u.bytes += pendingBytes;
  const notes = u.notes + (u.existing === null ? 1 : 0);
  const bytes = u.bytes - (u.existing ?? 0) + newBytes;
  const now = `Current usage of ${where}: ${u.notes} notes, ${u.bytes} bytes`;
  if (limits.maxNotes !== undefined && notes > limits.maxNotes && notes > u.notes) {
    throw new SpaceLimitError(
      `Note limit reached for ${where}: this write would make ${notes} notes (limit ${limits.maxNotes}). ${now}. ${hint}`,
    );
  }
  if (limits.maxProjectBytes !== undefined && bytes > limits.maxProjectBytes && bytes > u.bytes) {
    throw new SpaceLimitError(
      `Size limit reached for ${where}: this write would make ${bytes} bytes (limit ${limits.maxProjectBytes}). ${now}. ${hint}`,
    );
  }
}
