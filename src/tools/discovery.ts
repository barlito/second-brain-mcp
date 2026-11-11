// Shared plumbing for kb_list / kb_search: optional hierarchical scope args,
// ACL gate, ACL-filtered tree walk, one audit row per call.
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext, TokenContext } from "../auth/context";
import { Scope } from "../auth/types";
import { canReadUnderProject, canReadUnderSpace } from "../acl/readable";
import { checkScope } from "../acl/check";
import { isValidSlug } from "../vault/paths";
import { listSubdirs } from "../vault/enumerate";
import { redact } from "../vault/git";
import { clientMessage, errorMessage, safeAudit, toolError, ToolRunResult } from "./common";

export const ARCHIVE_SECTION = "archive";

export const optSlug = (name: string) =>
  z.string().max(64, `${name} must be at most 64 characters`).optional().describe(`Optional ${name} slug`);

export interface ScopeArgs {
  space?: string;
  project?: string;
  section?: string;
}

// Same contract as withAclAndAudit (one audit row per call; slug syntax and
// ACL before any filesystem access; shared error mapping), but the target
// levels are optional and the ACL gate is "can read under the deepest level".
export async function discoveryCall(
  action: string,
  args: ScopeArgs,
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
      space: args.space,
      project: args.project,
      section: args.section,
      clientIp: c.clientIp,
    };

    // Syntax and hierarchy first; neither reveals anything about the vault.
    for (const field of ["space", "project", "section"] as const) {
      const v = args[field];
      if (v !== undefined && !isValidSlug(v)) {
        safeAudit({ ...base, result: "error", detail: `invalid ${field} slug` }, c.name);
        return toolError("Invalid space/project/section/note name.");
      }
    }
    if (
      (args.project !== undefined && args.space === undefined) ||
      (args.section !== undefined && args.project === undefined)
    ) {
      safeAudit({ ...base, result: "error", detail: "hierarchy violation" }, c.name);
      return toolError("Invalid arguments: project requires space, section requires project.");
    }

    // The deepest given level must be readable before any directory is touched.
    const { space, project, section } = args;
    const allowed =
      space === undefined
        ? true // results are filtered per entry; a token with no read scope sees nothing
        : project === undefined
          ? canReadUnderSpace(c.scopes, space)
          : section === undefined
            ? canReadUnderProject(c.scopes, space, project)
            : checkScope(c.scopes, space, project, section, "read");
    if (!allowed) {
      safeAudit({ ...base, result: "denied" }, c.name);
      return toolError("Permission denied.");
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
    console.error(`tool ${action} failed (token=${ctx?.name ?? "unknown"}): ${redact(errorMessage(err))}`);
    return toolError("Internal error.");
  }
}

export interface SectionRef {
  space: string;
  project: string;
  section: string;
}

// The single ACL/archive rule for "children of <parts> this token may see":
// parts=[] -> spaces, [space] -> projects, [space, project] -> sections.
// `only` names one child instead of listing the directory. The ACL is applied
// before any deeper directory is read.
export async function readableChildren(
  vaultRoot: string,
  scopes: Scope[],
  parts: string[],
  includeArchived: boolean,
  only?: string,
): Promise<string[]> {
  const names = only !== undefined ? [only] : await listSubdirs(vaultRoot, parts);
  return names.filter((name) => {
    if (parts.length === 0) return canReadUnderSpace(scopes, name);
    if (parts.length === 1) return canReadUnderProject(scopes, parts[0], name);
    return (includeArchived || name !== ARCHIVE_SECTION) && checkScope(scopes, parts[0], parts[1], name, "read");
  });
}

// Readable sections under the optional filters, sorted. A directory that
// cannot be listed (EACCES, EIO, symlinked, ...) is skipped and counted.
export async function* readableSections(
  vaultRoot: string,
  scopes: Scope[],
  f: ScopeArgs,
  includeArchived: boolean,
  stats: { skipped: number },
): AsyncGenerator<SectionRef> {
  const children = async (parts: string[], only?: string): Promise<string[]> => {
    try {
      return await readableChildren(vaultRoot, scopes, parts, includeArchived, only);
    } catch {
      stats.skipped++;
      return [];
    }
  };
  for (const space of await children([], f.space)) {
    for (const project of await children([space], f.project)) {
      for (const section of await children([space, project], f.section)) {
        yield { space, project, section };
      }
    }
  }
}
