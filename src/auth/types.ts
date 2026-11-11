export const PERMISSIONS = ["read", "write", "propose"] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Each of space/project/section is a slug or "*". "*" is only valid as trailing
// levels (see validateTokenInput): *:*:*, space:*:*, space:project:*, or explicit.
export interface Scope {
  space: string;
  project: string;
  section: string;
  permission: Permission;
}
