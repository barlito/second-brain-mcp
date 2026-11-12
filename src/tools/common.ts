// Shared plumbing for kb_* tools: ACL check + audit + error mapping + arg shapes.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext, TokenContext } from "../auth/context";
import { Permission } from "../auth/types";
import { checkScope } from "../acl/check";
import { AuditEntry, logAudit } from "../audit";
import { InvalidSlugError, isValidSlug, UnsafePathError } from "../vault/paths";
import { redact, SyncConflictError, VaultBusyError } from "../vault/git";

export const MAX_CONTENT_CHARS = 512 * 1024;

// A write whose content was identical: nothing committed, so no sha to report.
export const NO_CHANGES_MESSAGE = "No changes (content identical).";
// Same rule as the web editor (admin/vault NOT_UTF8_MESSAGE): never decode and rewrite such a note.
export const NOTE_NOT_UTF8_MESSAGE = "Note is not valid UTF-8; edit it in git.";

// Dependencies handed to every tool's register().
export interface ToolDeps {
  vaultRoot: string;
}

export type RegisterTool = (server: McpServer, deps: ToolDeps) => void;

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const slugArg = (name: string, desc: string) =>
  z.string().max(64, `${name} must be at most 64 characters`).describe(desc);

export const spaceArg = slugArg("space", "Space slug (top-level area, e.g. perso, pro)");
export const projectArg = slugArg("project", "Project slug");
export const sectionArg = slugArg("section", "Section slug");
export const noteArg = slugArg("note", "Note slug (without .md extension)");

export const kbArgsShape = {
  space: spaceArg,
  project: projectArg,
  section: sectionArg,
  note: noteArg,
};

// Extra audit fields a tool handler wants recorded alongside its result
// (e.g. kb_write's commit sha, kb_read's "note not found" detail).
export interface AuditExtra {
  detail?: string;
  gitCommit?: string;
}

export interface ToolRunResult {
  toolResult: CallToolResult;
  audit?: AuditExtra;
}

// An audit failure must never turn into a client-visible failure (least of
// all after a write already landed): log it and carry on.
export function safeAudit(entry: AuditEntry, tokenName: string): void {
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
export function clientMessage(err: unknown): string {
  if (err instanceof InvalidSlugError) return "Invalid space/project/section/note name.";
  if (err instanceof UnsafePathError) return "Path not allowed.";
  if (err instanceof SyncConflictError) {
    return `Conflict: this note was changed remotely. Your version was saved on branch ${err.backupBranch ?? "(none)"}. Re-read the note and retry.`;
  }
  if (err instanceof VaultBusyError) return "Vault is busy, retry in a moment.";
  return "Internal error.";
}

export interface Target {
  space: string;
  project: string;
  section: string;
  note: string;
}

// Shared ACL-check + audit-log + error-handling wrapper for kb_* tools.
// Every call gets exactly one audit row, whether it's denied, ok, a handled
// tool-level error, or an unexpected exception. Slug validation, then ACL, run before any filesystem access.
export async function withAclAndAudit(
  action: string,
  target: Target,
  permission: Permission | Permission[], // an array means any of them suffices
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
): Promise<CallToolResult> {
  let ctx: TokenContext | undefined;
  try {
    ctx = getTokenContext();
    const base = {
      tokenId: ctx.tokenId,
      tokenName: ctx.name,
      action,
      space: target.space,
      project: target.project,
      section: target.section,
      note: target.note,
      clientIp: ctx.clientIp,
    };

    // Slug syntax first: a literal "*", empty or garbage value must never reach checkScope
    // or the filesystem. Syntax reveals nothing about the vault, so this leaks nothing.
    for (const field of ["space", "project", "section", "note"] as const) {
      if (!isValidSlug(target[field])) {
        safeAudit({ ...base, result: "error", detail: `invalid ${field} slug` }, ctx.name);
        return toolError("Invalid space/project/section/note name.");
      }
    }

    const anyOf = Array.isArray(permission) ? permission : [permission];
    if (!anyOf.some((p) => checkScope(ctx!.scopes, target.space, target.project, target.section, p))) {
      safeAudit({ ...base, result: "denied" }, ctx.name);
      // Generic message: don't reveal whether the space/project/section exists.
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
