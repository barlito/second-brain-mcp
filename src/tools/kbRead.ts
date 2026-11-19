import { promises as fsp } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath, UnsafePathError } from "../vault/paths";
import { noteVersion } from "../vault/noteVersion";
import { readNoteAtRevision } from "../vault/git";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, toolError, withAclAndAudit } from "./common";

// Any note kb_write can produce fits (at most 4 UTF-8 bytes per char); anything
// bigger was put there out of band and is refused rather than loaded whole.
export const MAX_READ_BYTES = 4 * MAX_CONTENT_CHARS;

const notFound = { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length ? "\n" : "");
}

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_read",
    {
      description:
        "Read a note from the shared knowledge base vault. Pass `tail` (1-500) to get only the last N lines, e.g. recent journal history. " +
        "A second block `version: <sha>` identifies the note as read: pass it as `base_version` to kb_write/kb_edit (it proves you saw the latest version, not the whole note: tail reads return it too). " +
        "Pass `rev` (a sha from kb_history) to read the note as it was at that commit (the version block is then that revision's).",
      inputSchema: {
        ...kbArgsShape,
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of the note"),
        rev: z.string().regex(/^[0-9a-f]{7,40}$/, "must be 7-40 lowercase hex characters").optional().describe("Commit sha (from kb_history): read the note at that commit"),
      },
    },
    async ({ space, project, section, note, tail, rev }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", { space, project, section, note }, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);

        if (rev !== undefined) {
          const r = await readNoteAtRevision(vaultRoot, absolutePath, rev, MAX_READ_BYTES);
          if (!r.ok && r.reason === "unknown-rev") return { toolResult: toolError("Unknown revision."), audit: { detail: "unknown revision" } };
          if (!r.ok && r.reason === "missing") return { toolResult: toolError("Note not found at this revision."), audit: { detail: "note not found at revision" } };
          if (!r.ok) {
            return {
              toolResult: toolError(`Note is too large to read (${r.size} bytes, max ${MAX_READ_BYTES}).`),
              audit: { detail: `note too large (${r.size} bytes)` },
            };
          }
          const version = { type: "text" as const, text: `version: ${r.version}` };
          return { toolResult: { content: [{ type: "text", text: tail === undefined ? r.content : lastLines(r.content, tail) }, version] } };
        }

        // One fd, O_NOFOLLOW, bounded: a swap to a symlink after the path check is never followed.
        let r: Awaited<ReturnType<typeof readFileNoFollow>>;
        try {
          r = await readFileNoFollow(absolutePath, MAX_READ_BYTES);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Distinct from a permission error — the note simply doesn't exist.
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

        const version = { type: "text" as const, text: `version: ${noteVersion(r.raw)}` };
        return { toolResult: { content: [{ type: "text", text: tail === undefined ? r.content : lastLines(r.content, tail) }, version] } };
      }),
  );
};
