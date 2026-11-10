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
import { logAudit } from "./audit";
import { InvalidSlugError, resolveNotePath } from "./vault/paths";
import { syncWrite } from "./vault/git";

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
  project: z.string().describe("Project slug"),
  section: z.string().describe("Section slug"),
  note: z.string().describe("Note slug (without .md extension)"),
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

// Shared ACL-check + audit-log + error-handling wrapper for kb_* tools.
// Centralizes the one piece of behavior that must never be skipped: every
// call gets exactly one audit row, whether it's denied, ok, a handled
// tool-level error, or an unexpected exception — so a future tool can't
// forget to log an exit path the way duplicated per-tool code could.
async function withAclAndAudit(
  action: string,
  project: string,
  section: string,
  note: string,
  permission: "read" | "write",
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
): Promise<CallToolResult> {
  const ctx = getTokenContext();

  if (!checkScope(ctx.scopes, project, section, permission)) {
    logAudit({
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action,
      project,
      section,
      note,
      result: "denied",
    });
    // Generic message — don't reveal whether the project/section exists.
    return toolError("Permission denied.");
  }

  try {
    const { toolResult, audit } = await run(ctx);
    logAudit({
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action,
      project,
      section,
      note,
      result: toolResult.isError ? "error" : "ok",
      ...audit,
    });
    return toolResult;
  } catch (err) {
    logAudit({
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action,
      project,
      section,
      note,
      result: "error",
      detail: errorMessage(err),
    });
    // InvalidSlugError means the caller sent a malformed project/section/note —
    // their mistake, not a server failure — so say so instead of a generic
    // "Internal error.". The real reason is still in the audit row above.
    if (err instanceof InvalidSlugError) {
      return toolError("Invalid project/section/note name.");
    }
    return toolError("Internal error.");
  }
}

export function createMcpServer(vaultRoot: string): McpServer {
  const server = new McpServer({ name: "second-brain-mcp", version: "0.1.0" });

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
        content: z.string().describe("Full note content, written verbatim"),
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
