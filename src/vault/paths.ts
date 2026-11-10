import path from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

// Defense in depth: re-check the resolved path is still under vaultRoot, in
// case something slips past the slug regex (e.g. a future regex change).
function assertInsideRoot(resolvedRoot: string, resolvedPath: string): void {
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(prefix)) {
    throw new Error(`resolved path escapes vault root: ${resolvedPath}`);
  }
}

function assertValidSlug(kind: string, value: string): void {
  if (!isValidSlug(value)) throw new Error(`invalid ${kind} slug: ${value}`);
}

export function resolveNotePath(
  vaultRoot: string,
  project: string,
  section: string,
  note: string,
): string {
  assertValidSlug("project", project);
  assertValidSlug("section", section);
  assertValidSlug("note", note);

  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, project, section, `${note}.md`);

  assertInsideRoot(resolvedRoot, resolvedPath);

  return resolvedPath;
}

export function resolveSectionDir(vaultRoot: string, project: string, section: string): string {
  assertValidSlug("project", project);
  assertValidSlug("section", section);

  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, project, section);

  assertInsideRoot(resolvedRoot, resolvedPath);

  return resolvedPath;
}
