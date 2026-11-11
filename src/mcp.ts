// MCP tool definitions: kb_read / kb_write, wired to the ACL/audit/vault
// modules built in earlier PRs. A fresh McpServer is created per HTTP
// request (see server.ts, stateless Streamable HTTP mode), so this just
// builds and returns one.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext, TokenContext } from "./auth/context";
import { checkScope } from "./acl/check";
import { AuditEntry, logAudit } from "./audit";
import { InvalidSlugError, resolveNotePath, UnsafePathError } from "./vault/paths";
import { SyncConflictError, syncWrite, VaultBusyError } from "./vault/git";

// Read at runtime (not imported) so tsc rootDir stays src/; resolves to the
// repo-root package.json from both src/ and dist/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { name: string; version: string };

export const MAX_CONTENT_CHARS = 512 * 1024;

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const kbArgsShape = {
  project: z.string().max(64, "project must be at most 64 characters").describe("Project slug"),
  section: z.string().max(64, "section must be at most 64 characters").describe("Section slug"),
  note: z.string().max(64, "note must be at most 64 characters").describe("Note slug (without .md extension)"),
};

// Extra audit fields a tool handler wants recorded alongside its result
// (e.g. kb_write's commit sha, kb_read's "note not found" detail).
interface AuditExtra {
  detail?: string;
  gitCommit?: string;
}

interface ToolRunResult {
  toolResult: CallToolResult;
  audit?: AuditExtra;
}

// Strips credentials from URLs before anything is logged.
function redact(text: string): string {
  return text.replace(/:\/\/[^@\/]+@/g, "://***@");
}

// An audit failure must never turn into a client-visible failure (least of
// all after a write already landed): log it and carry on.
function safeAudit(entry: AuditEntry, tokenName: string): void {
  try {
    logAudit(entry);
  } catch (err) {
    console.error(
      `audit write failed (action=${entry.action} token=${tokenName} result=${entry.result}): ${redact(errorMessage(err))}`,
    );
  }
}

// Maps an internal failure to the message the client may see. The real reason
// only goes to the audit row and the server log.
function clientMessage(err: unknown): string {
  if (err instanceof InvalidSlugError) return "Invalid project/section/note name.";
  if (err instanceof UnsafePathError) return "Path not allowed.";
  if (err instanceof SyncConflictError) {
    return `Conflict: this note was changed remotely. Your version was saved on branch ${err.backupBranch ?? "(none)"}. Re-read the note and retry.`;
  }
  if (err instanceof VaultBusyError) return "Vault is busy, retry in a moment.";
  return "Internal error.";
}

// Shared ACL-check + audit-log + error-handling wrapper for kb_* tools.
// Every call gets exactly one audit row, whether it's denied, ok, a handled
// tool-level error, or an unexpected exception.
async function withAclAndAudit(
  action: string,
  project: string,
  section: string,
  note: string,
  permission: "read" | "write",
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
): Promise<CallToolResult> {
  let ctx: TokenContext | undefined;
  try {
    ctx = getTokenContext();
    const base = {
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action,
      project,
      section,
      note,
      clientIp: ctx.clientIp,
    };

    if (!checkScope(ctx.scopes, project, section, permission)) {
      safeAudit({ ...base, result: "denied" }, ctx.name);
      // Generic message: don't reveal whether the project/section exists.
      return toolError("Permission denied.");
    }

    try {
      const { toolResult, audit } = await run(ctx);
      safeAudit({ ...base, result: toolResult.isError ? "error" : "ok", ...audit }, ctx.name);
      return toolResult;
    } catch (err) {
      const reason = redact(errorMessage(err));
      console.error(`tool ${action} failed (token=${ctx.name}): ${reason}`);
      safeAudit({ ...base, result: "error", detail: reason }, ctx.name);
      return toolError(clientMessage(err));
    }
  } catch (err) {
    // Missing token context or similar wiring bug: log it, never leak it.
    console.error(`tool ${action} failed (token=${ctx?.name ?? "unknown"}): ${redact(errorMessage(err))}`);
    return toolError("Internal error.");
  }
}

export function createMcpServer(vaultRoot: string): McpServer {
  const server = new McpServer({ name: pkg.name, version: pkg.version });

  server.registerTool(
    "kb_read",
    {
      description: "Read a note from the shared knowledge base vault.",
      inputSchema: kbArgsShape,
    },
    async ({ project, section, note }): Promise<CallToolResult> =>
      withAclAndAudit("kb_read", project, section, note, "read", async () => {
        const absolutePath = resolveNotePath(vaultRoot, project, section, note);

        if (!existsSync(absolutePath)) {
          // Distinct from a permission error — the note simply doesn't exist.
          return { toolResult: toolError("Note not found."), audit: { detail: "note not found" } };
        }

        const content = readFileSync(absolutePath, "utf8");
        return { toolResult: toolText(content) };
      }),
  );

  server.registerTool(
    "kb_write",
    {
      description: "Write (create or overwrite) a note in the shared knowledge base vault.",
      inputSchema: {
        ...kbArgsShape,
        content: z
          .string()
          .max(MAX_CONTENT_CHARS, "content too large (max 512 KB)")
          .describe("Full note content, written verbatim"),
      },
    },
    async ({ project, section, note, content }): Promise<CallToolResult> =>
      withAclAndAudit("kb_write", project, section, note, "write", async (ctx) => {
        const absolutePath = resolveNotePath(vaultRoot, project, section, note);
        const { commitSha } = await syncWrite(
          vaultRoot,
          absolutePath,
          content,
          `kb_write: ${project}/${section}/${note} via ${ctx.name}`,
        );

        return { toolResult: toolText(commitSha), audit: { gitCommit: commitSha } };
      }),
  );

  return server;
}
