import { Permission, Scope } from "../auth/types";

// Exact match only — no wildcards (current schema/CLI don't support them, by design).
export function checkScope(
  scopes: Scope[],
  project: string,
  section: string,
  permission: Permission,
): boolean {
  return scopes.some(
    (s) => s.project === project && s.section === section && s.permission === permission,
  );
}
