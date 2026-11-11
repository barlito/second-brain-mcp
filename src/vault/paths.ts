import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

// Distinguishes caller input errors (bad space/project/section/note slug) from
// genuine internal failures, so callers (e.g. mcp.ts) can surface a clearer
// message instead of a generic "Internal error.".
export class InvalidSlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSlugError";
  }
}

// Thrown when a path is unsafe: a symlink, a non-regular file, or anything that
// resolves outside the vault root. Lets callers map it to a client message.
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

// Defense in depth: re-check the resolved path is still under vaultRoot, in
// case something slips past the slug regex (e.g. a future regex change).
function assertInsideRoot(resolvedRoot: string, resolvedPath: string): void {
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(prefix)) {
    throw new UnsafePathError(`resolved path escapes vault root: ${resolvedPath}`);
  }
}

// Lexical checks are not enough: a symlink arriving via `git pull` can point
// anywhere (outside the vault, or at another project's directory). Walk to the
// deepest existing ancestor and require its real path to equal the lexical
// one, i.e. no component of the existing prefix is a symlink.
export function assertSafePath(vaultRoot: string, target: string): void {
  const root = path.resolve(vaultRoot);
  const abs = path.resolve(target);
  assertInsideRoot(root, abs);

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return; // vault root doesn't exist yet: nothing inside it can be a symlink
  }

  let cur = abs;
  for (;;) {
    try {
      if (lstatSync(cur).isSymbolicLink()) throw new UnsafePathError(`symlink not allowed in vault: ${cur}`);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      if (cur === root) return;
      cur = path.dirname(cur);
    }
  }

  if (realpathSync(cur) !== path.join(realRoot, path.relative(root, cur))) {
    throw new UnsafePathError(`path resolves outside its expected location: ${abs}`);
  }
}

function assertValidSlug(kind: string, value: string): void {
  if (!isValidSlug(value)) throw new InvalidSlugError(`invalid ${kind} slug: ${value}`);
}

export function resolveNotePath(
  vaultRoot: string,
  space: string,
  project: string,
  section: string,
  note: string,
): string {
  assertValidSlug("space", space);
  assertValidSlug("project", project);
  assertValidSlug("section", section);
  assertValidSlug("note", note);

  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, space, project, section, `${note}.md`);

  assertInsideRoot(resolvedRoot, resolvedPath);
  assertSafePath(resolvedRoot, resolvedPath);
  try {
    if (!lstatSync(resolvedPath).isFile()) throw new UnsafePathError(`not a regular file: ${resolvedPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return resolvedPath;
}

export function resolveSectionDir(vaultRoot: string, space: string, project: string, section: string): string {
  assertValidSlug("space", space);
  assertValidSlug("project", project);
  assertValidSlug("section", section);

  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, space, project, section);

  assertInsideRoot(resolvedRoot, resolvedPath);
  assertSafePath(resolvedRoot, resolvedPath);

  return resolvedPath;
}
