import { Scope } from "../auth/tokens";

// Exact match only — no wildcards (current schema/CLI don't support them, by design).
export function checkScope(
  scopes: Scope[],
  project: string,
  section: string,
  permission: "read" | "write",
): boolean {
  return scopes.some(
    (s) => s.project === project && s.section === section && s.permission === permission,
  );
}
