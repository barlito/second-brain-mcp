// "Can this token read anything under X?" helpers for discovery tools (kb_list,
// kb_search). Exact per-section checks stay with checkScope. Malformed stored
// scopes (a non-"*" level after a "*") grant nothing, same as checkScope.
import { Scope } from "../auth/types";
import { INBOX_SPACE, wellFormed } from "./check";

function readScopes(scopes: Scope[]): Scope[] {
  return scopes.filter((s) => s.permission === "read" && wellFormed(s));
}

// At least one read scope could match some section in this space.
export function canReadUnderSpace(scopes: Scope[], space: string): boolean {
  if (space === INBOX_SPACE) return false;
  return readScopes(scopes).some((s) => s.space === "*" || s.space === space);
}

// At least one read scope could match some section in this project.
export function canReadUnderProject(scopes: Scope[], space: string, project: string): boolean {
  if (space === INBOX_SPACE) return false;
  return readScopes(scopes).some(
    (s) => (s.space === "*" || s.space === space) && (s.project === "*" || s.project === project),
  );
}
