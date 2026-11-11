// Shared plumbing for kb_list / kb_search: optional hierarchical scope args,
// ACL gate, ACL-filtered tree walk, one audit row per call.
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTokenContext, TokenContext } from "../auth/context";
import { canReadUnderProject, canReadUnderSpace } from "../acl/readable";
import { checkScope } from "../acl/check";
import { logAudit } from "../audit";
import { InvalidSlugError, isValidSlug, UnsafePathError } from "../vault/paths";
import { listSubdirs } from "../vault/enumerate";
import { redact } from "../vault/git";
import { toolError } from "./common";

export const ARCHIVE_SECTION = "archive";

export const optSlug = (name: string) =>
  z.string().max(64, `${name} must be at most 64 characters`).optional().describe(`Optional ${name} slug`);

export interface ScopeArgs {
  space?: string;
  project?: string;
  section?: string;
}

export interface DiscoveryResult {
  result: CallToolResult;
  detail?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function discoveryCall(
  action: string,
  args: ScopeArgs,
  run: (ctx: TokenContext) => DiscoveryResult,
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
    const audit = (result: "ok" | "denied" | "error", detail?: string) => {
      try {
        logAudit({ ...base, result, detail });
      } catch (err) {
        console.error(`audit write failed (action=${action} token=${c.name}): ${redact(errorMessage(err))}`);
      }
    };

    // Syntax and hierarchy first; neither reveals anything about the vault.
    for (const field of ["space", "project", "section"] as const) {
      const v = args[field];
      if (v !== undefined && !isValidSlug(v)) {
        audit("error", `invalid ${field} slug`);
        return toolError("Invalid space/project/section/note name.");
      }
    }
    if (
      (args.project !== undefined && args.space === undefined) ||
      (args.section !== undefined && args.project === undefined)
    ) {
      audit("error", "hierarchy violation");
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
      audit("denied");
      return toolError("Permission denied.");
    }

    try {
      const { result, detail } = run(c);
      audit(result.isError ? "error" : "ok", detail);
      return result;
    } catch (err) {
      const reason = redact(errorMessage(err));
      console.error(`tool ${action} failed (token=${c.name}): ${reason}`);
      audit("error", reason);
      if (err instanceof InvalidSlugError) return toolError("Invalid space/project/section/note name.");
      return toolError(err instanceof UnsafePathError ? "Path not allowed." : "Internal error.");
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

// Readable sections under the given (optional) filters, sorted. The ACL is
// applied at every level BEFORE the next directory is read, so names the token
// cannot read are never even enumerated.
export function* readableSections(
  vaultRoot: string,
  ctx: TokenContext,
  f: ScopeArgs,
  includeArchived: boolean,
): Generator<SectionRef> {
  const spaces = f.space ? [f.space] : listSubdirs(vaultRoot, []).filter((s) => canReadUnderSpace(ctx.scopes, s));
  for (const space of spaces) {
    const projects = f.project
      ? [f.project]
      : listSubdirs(vaultRoot, [space]).filter((p) => canReadUnderProject(ctx.scopes, space, p));
    for (const project of projects) {
      if (!canReadUnderProject(ctx.scopes, space, project)) continue;
      const sections = f.section ? [f.section] : listSubdirs(vaultRoot, [space, project]);
      for (const section of sections) {
        if (section === ARCHIVE_SECTION && !includeArchived) continue;
        if (!checkScope(ctx.scopes, space, project, section, "read")) continue;
        yield { space, project, section };
      }
    }
  }
}
