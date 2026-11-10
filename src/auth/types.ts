export const PERMISSIONS = ["read", "write"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Scope {
  project: string;
  section: string;
  permission: Permission;
}
