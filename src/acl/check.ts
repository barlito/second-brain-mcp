import { Permission, Scope } from "../auth/types";

const warned = new Set<string>();

// "*" is only valid as trailing levels (*:*:*, space:*:*, space:project:*). Rows that
// bypassed createToken (manual SQL, old backups) with a non-"*" level after a "*" are
// malformed: they match nothing, and we warn once per distinct row.
export function wellFormed(s: Scope): boolean {
  const ok = s.space === "*" ? s.project === "*" && s.section === "*" : s.project === "*" ? s.section === "*" : true;
  if (!ok) {
    const key = `${s.space}:${s.project}:${s.section}:${s.permission}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`warning: ignoring malformed stored scope ${key} ("*" must only be used for trailing levels)`);
    }
  }
  return ok;
}

// A scope level matches exactly or via a trailing "*". read and write are independent.
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
      wellFormed(s) &&
      (s.space === "*" || s.space === space) &&
      (s.project === "*" || s.project === project) &&
      (s.section === "*" || s.section === section),
  );
}
