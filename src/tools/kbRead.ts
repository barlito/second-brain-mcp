import { promises as fsp } from "node:fs";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileNoFollow } from "../vault/enumerate";
import { resolveNotePath, UnsafePathError } from "../vault/paths";
import { kbArgsShape, MAX_CONTENT_CHARS, RegisterTool, registerKbTool, toolError, toolText, withAclAndAudit } from "./common";

// Any note kb_write can produce fits (at most 4 UTF-8 bytes per char); anything
// bigger was put there out of band and is refused rather than loaded whole.
export const MAX_READ_BYTES = 4 * MAX_CONTENT_CHARS;

const notFound = { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_read",
    {
      description:
        "Read a note from the shared knowledge base vault. Pass `tail` (1-500) to get only the last N lines, e.g. recent journal history.",
      inputSchema: {
        ...kbArgsShape,
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last N lines of the note"),
      },
    },
    async ({ space, project, section, note, tail }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", { space, project, section, note }, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, space, project, section, note);

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

        const text = r.content;
        if (tail === undefined) return { toolResult: toolText(text) };
        const lines = text.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        return { toolResult: toolText(lines.slice(-tail).join("\n") + (lines.length ? "\n" : "")) };
      }),
  );
};
