// Shared plumbing for kb_* tools: argument validation + ACL gate + audit + error mapping.
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

const slugArg = (desc: string) => z.string().max(64, "must be at most 64 characters").describe(desc);

export const spaceArg = slugArg("Space slug (top-level area, e.g. perso, pro)");
export const projectArg = slugArg("Project slug");

export const kbArgsShape = {
  space: spaceArg,
  project: projectArg,
  section: slugArg("Section slug"),
  note: slugArg("Note slug (without .md extension)"),
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

// ---- argument validation ----
//
// The SDK validates inputSchema before our handler runs and answers a failure
// with a bare protocol error, so the call would never be audited. Each field is
// therefore wrapped so that validation never fails: a bad value is replaced by
// an InvalidArg marker, which the registered handler turns into an audited
// error. tools/list still publishes the original field schema (types, limits,
// required-ness) unchanged.

const INVALID = Symbol("invalid argument");

interface InvalidArg {
  [INVALID]: true;
  issue: string;
}

function isInvalidArg(v: unknown): v is InvalidArg {
  return typeof v === "object" && v !== null && INVALID in v;
}

function lenient(schema: z.ZodType): z.ZodType {
  const optional = schema.safeParse(undefined).success;
  const caught = schema.catch((ctx: z.core.$ZodCatchCtx | undefined) => {
    // Called without ctx when tools/list renders the JSON schema: no default to publish.
    // (ctx.error holds the finalized issues with messages; ctx.issues does not.)
    if (!ctx) return undefined as never;
    const issue = ctx.input === undefined ? "required" : (ctx.error.issues[0]?.message ?? "invalid value");
    return { [INVALID]: true, issue } satisfies InvalidArg as never;
  });
  // The identity preprocess keeps the field required in the published schema
  // (a bare .catch() would mark it optional); optional fields stay optional.
  const field = z.preprocess((v) => v, caught);
  return optional ? field.optional() : field;
}

// First invalid argument as a client-safe message, in schema order.
function invalidArgMessage(args: Record<string, unknown>, shape: z.ZodRawShape): string | undefined {
  for (const field of Object.keys(shape)) {
    const v = args[field];
    if (isInvalidArg(v)) return `Invalid argument \`${field}\`: ${v.issue.replace(/\.$/, "")}.`;
  }
  return undefined;
}

export interface ToolConfig<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
}

// Registers a kb_* tool whose argument validation is audited like everything
// else: a schema failure gets one "error" audit row and a clear message instead
// of an unaudited protocol error.
export function registerKbTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const shape = Object.fromEntries(Object.entries(config.inputSchema).map(([k, s]) => [k, lenient(s as z.ZodType)]));
  const cb = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const invalid = invalidArgMessage(args, config.inputSchema);
    if (invalid === undefined) return handler(args as z.output<z.ZodObject<S>>);
    const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const target = { space: str("space"), project: str("project"), section: str("section"), note: str("note") };
    return auditedCall(
      name,
      target,
      () => ({ result: "error", message: invalid, detail: `invalid arguments: ${invalid}` }),
      async () => {
        throw new Error("unreachable");
      },
    );
  };
  server.registerTool(name, { description: config.description, inputSchema: shape }, cb as never);
}

// ---- audited call ----

export interface AuditTarget {
  space?: string;
  project?: string;
  section?: string;
  note?: string;
}

export interface Target {
  space: string;
  project: string;
  section: string;
  note: string;
}

// What a gate returns to stop a call before any filesystem access; undefined = proceed.
export interface GateRefusal {
  result: "denied" | "error";
  message: string;
  detail?: string;
}

export type Gate = (ctx: TokenContext) => GateRefusal | undefined;

// The one audited-call path for every kb_* tool. Every call gets exactly one
// audit row, whether it's refused by the gate, ok, a handled tool-level error,
// or an unexpected exception.
export async function auditedCall(
  action: string,
  target: AuditTarget,
  gate: Gate,
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
): Promise<CallToolResult> {
  let ctx: TokenContext | undefined;
  try {
    ctx = getTokenContext();
    const c = ctx;
    const base = {
      tokenId: c.tokenId,
      tokenName: c.name,
      action,
      space: target.space,
      project: target.project,
      section: target.section,
      note: target.note,
      clientIp: c.clientIp,
    };

    const refused = gate(c);
    if (refused) {
      safeAudit({ ...base, result: refused.result, detail: refused.detail }, c.name);
      return toolError(refused.message);
    }

    try {
      const { toolResult, audit } = await run(c);
      safeAudit({ ...base, result: toolResult.isError ? "error" : "ok", ...audit }, c.name);
      return toolResult;
    } catch (err) {
      const reason = redact(errorMessage(err));
      console.error(`tool ${action} failed (token=${c.name}): ${reason}`);
      safeAudit({ ...base, result: "error", detail: reason }, c.name);
      return toolError(clientMessage(err));
    }
  } catch (err) {
    // Missing token context or similar wiring bug: log it, never leak it.
    console.error(`tool ${action} failed (token=${ctx?.name ?? "unknown"}): ${redact(errorMessage(err))}`);
    return toolError("Internal error.");
  }
}

export const INVALID_NAME = "Invalid space/project/section/note name.";
export const PERMISSION_DENIED = "Permission denied.";

// A permission every call needs on top of the main one, optionally on another
// section of the same project (e.g. kb_archive: write on `archive`).
export interface ExtraPermission {
  permission: Permission;
  section?: string;
  detail: string;
}

// Gate for tools addressing one note: slug syntax, then ACL. `permission` as an
// array means any of them suffices; every `also` entry is required as well.
export function noteGate(target: Target, permission: Permission | Permission[], also: ExtraPermission[] = []): Gate {
  return (ctx) => {
    // Slug syntax first: a literal "*", empty or garbage value must never reach checkScope
    // or the filesystem. Syntax reveals nothing about the vault, so this leaks nothing.
    for (const field of ["space", "project", "section", "note"] as const) {
      if (!isValidSlug(target[field])) return { result: "error", message: INVALID_NAME, detail: `invalid ${field} slug` };
    }
    const { space, project, section } = target;
    const anyOf = Array.isArray(permission) ? permission : [permission];
    // Generic message: don't reveal whether the space/project/section exists.
    if (!anyOf.some((p) => checkScope(ctx.scopes, space, project, section, p))) {
      return { result: "denied", message: PERMISSION_DENIED };
    }
    for (const x of also) {
      if (!checkScope(ctx.scopes, space, project, x.section ?? section, x.permission)) {
        return { result: "denied", message: PERMISSION_DENIED, detail: x.detail };
      }
    }
    return undefined;
  };
}

// auditedCall with the per-note gate. Slug validation, then ACL, run before any filesystem access.
export function withAclAndAudit(
  action: string,
  target: Target,
  permission: Permission | Permission[],
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
  also: ExtraPermission[] = [],
): Promise<CallToolResult> {
  return auditedCall(action, target, noteGate(target, permission, also), run);
}
