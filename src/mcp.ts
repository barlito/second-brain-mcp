// MCP tool definitions: kb_read / kb_write, wired to the ACL/audit/vault
// modules built in earlier PRs. A fresh McpServer is created per HTTP
// request (see server.ts, stateless Streamable HTTP mode), so this just
// builds and returns one.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext } from "./auth/context";
import { checkScope } from "./acl/check";
import { logAudit } from "./audit";
import { resolveNotePath } from "./vault/paths";
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

export function createMcpServer(vaultRoot: string): McpServer {
  const server = new McpServer({ name: "second-brain-mcp", version: "0.1.0" });

  server.registerTool(
    "kb_read",
    {
      description: "Read a note from the shared knowledge base vault.",
      inputSchema: kbArgsShape,
    },
    async ({ project, section, note }): Promise<CallToolResult> => {
      const ctx = getTokenContext();
      try {
        if (!checkScope(ctx.scopes, project, section, "read")) {
          logAudit({
            tokenId: ctx.tokenId,
            tokenName: ctx.name,
            action: "kb_read",
            project,
            section,
            note,
            result: "denied",
          });
          // Generic message — don't reveal whether the project/section exists.
          return toolError("Permission denied.");
        }

        const absolutePath = resolveNotePath(vaultRoot, project, section, note);

        let content: string;
        try {
          content = readFileSync(absolutePath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            logAudit({
              tokenId: ctx.tokenId,
              tokenName: ctx.name,
              action: "kb_read",
              project,
              section,
              note,
              result: "error",
              detail: "note not found",
            });
            // Distinct from a permission error — the note simply doesn't exist.
            return toolError("Note not found.");
          }
          throw err;
        }

        logAudit({
          tokenId: ctx.tokenId,
          tokenName: ctx.name,
          action: "kb_read",
          project,
          section,
          note,
          result: "ok",
        });
        return toolText(content);
      } catch (err) {
        logAudit({
          tokenId: ctx.tokenId,
          tokenName: ctx.name,
          action: "kb_read",
          project,
          section,
          note,
          result: "error",
          detail: errorMessage(err),
        });
        return toolError("Internal error.");
      }
    },
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
    async ({ project, section, note, content }): Promise<CallToolResult> => {
      const ctx = getTokenContext();
      try {
        if (!checkScope(ctx.scopes, project, section, "write")) {
          logAudit({
            tokenId: ctx.tokenId,
            tokenName: ctx.name,
            action: "kb_write",
            project,
            section,
            note,
            result: "denied",
          });
          return toolError("Permission denied.");
        }

        const absolutePath = resolveNotePath(vaultRoot, project, section, note);
        const { commitSha } = await syncWrite(
          vaultRoot,
          absolutePath,
          content,
          `kb_write: ${project}/${section}/${note} via ${ctx.name}`,
        );

        logAudit({
          tokenId: ctx.tokenId,
          tokenName: ctx.name,
          action: "kb_write",
          project,
          section,
          note,
          result: "ok",
          gitCommit: commitSha,
        });
        return toolText(commitSha);
      } catch (err) {
        logAudit({
          tokenId: ctx.tokenId,
          tokenName: ctx.name,
          action: "kb_write",
          project,
          section,
          note,
          result: "error",
          detail: errorMessage(err),
        });
        return toolError("Internal error.");
      }
    },
  );

  return server;
}
