import { Permission, Scope } from "../auth/types";

// A scope level matches exactly or via "*" (only trailing levels may be "*",
// enforced at token creation). read and write are independent permissions.
export function checkScope(
  scopes: Scope[],
  space: string,
  project: string,
  section: string,
  permission: Permission,
): boolean {
  return scopes.some(
    (s) =>
      s.permission === permission &&
      (s.space === "*" || s.space === space) &&
      (s.project === "*" || s.project === project) &&
      (s.section === "*" || s.section === section),
  );
}
