// Shared plumbing for kb_list / kb_search: optional hierarchical scope args,
// ACL gate, ACL-filtered tree walk, one audit row per call.
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TokenContext } from "../auth/context";
import { Scope } from "../auth/types";
import { canReadUnderProject, canReadUnderSpace } from "../acl/readable";
import { checkScope } from "../acl/check";
import { isValidSlug } from "../vault/paths";
import { listSubdirs } from "../vault/enumerate";
import { auditedCall, Gate, INVALID_NAME, PERMISSION_DENIED, ToolRunResult } from "./common";
import { ARCHIVE_SECTION } from "./reserved";

export const optSlug = (name: string) =>
  z.string().max(64, "must be at most 64 characters").optional().describe(`Optional ${name} slug`);

export interface ScopeArgs {
  space?: string;
  project?: string;
  section?: string;
}

// Gate for discovery tools: the target levels are optional; syntax and
// hierarchy first (neither reveals anything about the vault), then "can read
// under the deepest given level", all before any directory is touched.
function discoveryGate(args: ScopeArgs): Gate {
  return (c) => {
    for (const field of ["space", "project", "section"] as const) {
      const v = args[field];
      if (v !== undefined && !isValidSlug(v)) return { result: "error", message: INVALID_NAME, detail: `invalid ${field} slug` };
    }
    if (
      (args.project !== undefined && args.space === undefined) ||
      (args.section !== undefined && args.project === undefined)
    ) {
      return {
        result: "error",
        message: "Invalid arguments: project requires space, section requires project.",
        detail: "hierarchy violation",
      };
    }
    const { space, project, section } = args;
    const allowed =
      space === undefined
        ? true // results are filtered per entry; a token with no read scope sees nothing
        : project === undefined
          ? canReadUnderSpace(c.scopes, space)
          : section === undefined
            ? canReadUnderProject(c.scopes, space, project)
            : checkScope(c.scopes, space, project, section, "read");
    return allowed ? undefined : { result: "denied", message: PERMISSION_DENIED };
  };
}

// Same contract as withAclAndAudit (shared auditedCall), with the discovery gate.
export function discoveryCall(
  action: string,
  args: ScopeArgs,
  run: (ctx: TokenContext) => Promise<ToolRunResult>,
): Promise<CallToolResult> {
  return auditedCall(action, args, discoveryGate(args), run);
}

export interface SectionRef {
  space: string;
  project: string;
  section: string;
}

// The single ACL/archive rule for "children of <parts> this token may see":
// parts=[] -> spaces, [space] -> projects, [space, project] -> sections.
// `only` names one child instead of listing the directory; an explicitly named
// archive section counts as included. The ACL is applied before any deeper
// directory is read.
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
    return (includeArchived || only !== undefined || name !== ARCHIVE_SECTION) && checkScope(scopes, parts[0], parts[1], name, "read");
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
