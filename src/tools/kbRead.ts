import { promises as fsp } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath, UnsafePathError } from "../vault/paths";
import { noteVersion } from "../vault/noteVersion";
import { readNoteAtRevision } from "../vault/git";
import {
  canReadNotePath,
  kbArgsShape,
  MAX_CONTENT_CHARS,
  RegisterTool,
  registerKbTool,
  Target,
  ToolRunResult,
  versionBlock,
  toolError,
  toolText,
  withAclAndAudit,
} from "./common";

// Any note kb_write can produce fits (at most 4 UTF-8 bytes per char); anything
// bigger was put there out of band and is refused rather than loaded whole.
export const MAX_READ_BYTES = 4 * MAX_CONTENT_CHARS;

export const NOT_FOUND_MESSAGE = "Note not found.";
const notFound = { toolResult: toolError(NOT_FOUND_MESSAGE), audit: { detail: "note not found" } };

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length ? "\n" : "");
}

// Reads one note (ACL already checked by the caller); shared by kb_read, kb_read_many and kb_context.
// `withVersion` adds the `version: <sha>` block (kb_read only), computed on the bytes returned.
export async function readNote(vaultRoot: string, t: Target, tail?: number, withVersion = false): Promise<ToolRunResult> {
  const absolutePath = resolveNotePath(vaultRoot, t.space, t.project, t.section, t.note);

  // One fd, O_NOFOLLOW, bounded: a swap to a symlink after the path check is never followed.
  let r: Awaited<ReturnType<typeof readFileNoFollow>>;
  try {
    r = await readFileNoFollow(absolutePath, MAX_READ_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Distinct from a permission error: the note simply doesn't exist.
    if (code === "ENOENT") return notFound;
    if (code === "ELOOP") throw new UnsafePathError(`symlink not allowed in vault: ${absolutePath}`);
    throw err;
  }
  if (!r) {
    const st = await fsp.lstat(absolutePath).catch(() => undefined);
    if (!st) return notFound;
    if (!st.isFile()) throw new UnsafePathError(`not a regular file: ${absolutePath}`);
    return {
      toolResult: toolError(`Note is too large to read (${st.size} bytes, max ${MAX_READ_BYTES}).`),
      audit: { detail: `note too large (${st.size} bytes)` },
    };
  }
  const text = tail === undefined ? r.content : lastLines(r.content, tail);
  if (!withVersion) return { toolResult: toolText(text) };
  return { toolResult: { content: [{ type: "text", text }, versionBlock(noteVersion(r.raw))] } };
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_read",
    {
      description:
        "Read a note from the shared knowledge base vault. Pass `tail` (1-500) to get only the last N lines, e.g. recent journal history. " +
        "A second block `version: <sha>` (not part of the note) identifies the note as read: pass it as `base_version` to kb_write/kb_edit (it proves you saw the latest version, not the whole note: tail reads return it too). " +
        "Pass `rev` (a sha from kb_history) to read the note as it was at that commit (the version block is then that revision's).",
      inputSchema: {
        ...kbArgsShape,
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of the note"),
        rev: z.string().regex(/^[0-9a-f]{7,40}$/, "must be 7-40 lowercase hex characters").optional().describe("Commit sha (from kb_history): read the note at that commit"),
      },
    },
    async ({ space, project, section, note, tail, rev }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", { space, project, section, note }, "read", async (ctx) => {
        const t = { space, project, section, note };
        if (rev === undefined) return readNote(vaultRoot, t, tail, true);

        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);
        const r = await readNoteAtRevision(vaultRoot, absolutePath, rev, MAX_READ_BYTES, (p) => canReadNotePath(ctx.scopes, p));
        if (!r.ok && r.reason === "unknown-rev") return { toolResult: toolError("Unknown revision."), audit: { detail: "unknown revision" } };
        if (!r.ok && r.reason === "missing") return { toolResult: toolError("Note not found at this revision."), audit: { detail: "note not found at revision" } };
        if (!r.ok) {
          return {
            toolResult: toolError(`Note is too large to read (${r.size} bytes, max ${MAX_READ_BYTES}).`),
            audit: { detail: `note too large (${r.size} bytes)` },
          };
        }
        const text = tail === undefined ? r.content : lastLines(r.content, tail);
        return { toolResult: { content: [{ type: "text", text }, versionBlock(r.version)] } };
      }),
  );
};
