// SESSION_BASELINE_SCOPES: read scopes every token-less session holds from its first request,
// without an access request (typically `meta:*:*:read`, the user's short notes on how they work).
// Only a valid connector key opens a session, so this is what a leaked key exposes: read-only by
// construction, and validated at startup so a typo never silently widens or drops access.
import { isValidSlug } from "../vault/paths";
import { wellFormed } from "../acl/check";
import { Scope } from "./types";

const level = (v: string): boolean => v === "*" || isValidSlug(v);

export function sessionBaselineScopes(env: NodeJS.ProcessEnv = process.env): Scope[] {
  const raw = (env.SESSION_BASELINE_SCOPES ?? "").trim();
  if (raw === "") return [];
  return raw.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length !== 4) throw new Error(`SESSION_BASELINE_SCOPES: invalid scope "${entry}", expected space:project:section:read`);
    const [space, project, section, permission] = parts;
    if (permission !== "read") throw new Error(`SESSION_BASELINE_SCOPES: "${entry}" must be read-only (permission "read")`);
    if (![space, project, section].every(level)) throw new Error(`SESSION_BASELINE_SCOPES: invalid slug in "${entry}"`);
    const s: Scope = { space, project, section, permission };
    if (!wellFormed(s)) throw new Error(`SESSION_BASELINE_SCOPES: "${entry}" has "*" before a named level`);
    if (space === "*") throw new Error(`SESSION_BASELINE_SCOPES: "${entry}" would open every space; name the space`);
    return s;
  });
}
