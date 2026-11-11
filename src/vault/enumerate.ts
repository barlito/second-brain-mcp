// Safe directory enumeration for discovery tools. Callers must apply the ACL
// BEFORE calling these for a given directory. Skips dotfiles, symlinks,
// non-directories/non-.md files and names that are not valid slugs.
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertSafePath, isValidSlug } from "./paths";

export interface NoteInfo {
  name: string;
  size: number;
  mtime: Date;
}

function readDir(vaultRoot: string, parts: string[]) {
  const dir = path.resolve(vaultRoot, ...parts);
  assertSafePath(vaultRoot, dir);
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

// Slug-named real subdirectories of vaultRoot/<parts...>, sorted. Dirent
// reports symlinks as such (never as directories), so they are skipped.
export function listSubdirs(vaultRoot: string, parts: string[]): string[] {
  return readDir(vaultRoot, parts)
    .filter((e) => e.isDirectory() && isValidSlug(e.name))
    .map((e) => e.name)
    .sort();
}

// Regular, slug-named .md files of a section directory, sorted.
export function listNotes(vaultRoot: string, parts: string[]): NoteInfo[] {
  const dir = path.resolve(vaultRoot, ...parts);
  const out: NoteInfo[] = [];
  for (const e of readDir(vaultRoot, parts)) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const name = e.name.slice(0, -3);
    if (!isValidSlug(name)) continue;
    try {
      const st = lstatSync(path.join(dir, e.name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtime });
    } catch {
      // vanished between readdir and lstat
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
