// Safe directory enumeration for discovery tools. Callers must apply the ACL
// BEFORE calling these for a given directory. Skips dotfiles, symlinks,
// non-directories/non-.md files and names that are not valid slugs.
import { constants, promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { assertSafePath, isValidSlug } from "./paths";

export interface NoteInfo {
  name: string;
  size: number;
  mtime: Date;
}

async function readDir(vaultRoot: string, parts: string[]): Promise<{ dir: string; entries: Dirent[] }> {
  const dir = path.resolve(vaultRoot, ...parts);
  assertSafePath(vaultRoot, dir);
  try {
    return { dir, entries: await fsp.readdir(dir, { withFileTypes: true }) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { dir, entries: [] };
    throw err;
  }
}

// Dirent reports symlinks as such. On DT_UNKNOWN filesystems it reports
// nothing at all: fall back to lstat (which still never follows symlinks).
async function kindOf(dir: string, e: Dirent): Promise<"file" | "dir" | "other"> {
  if (e.isSymbolicLink()) return "other";
  if (e.isFile()) return "file";
  if (e.isDirectory()) return "dir";
  try {
    const st = await fsp.lstat(path.join(dir, e.name));
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch {
    return "other";
  }
}

// Slug-named real subdirectories of vaultRoot/<parts...>, sorted.
export async function listSubdirs(vaultRoot: string, parts: string[]): Promise<string[]> {
  const { dir, entries } = await readDir(vaultRoot, parts);
  const out: string[] = [];
  for (const e of entries) {
    if (isValidSlug(e.name) && (await kindOf(dir, e)) === "dir") out.push(e.name);
  }
  return out.sort();
}

// Slug-named regular .md files (names without extension), sorted. No stat.
export async function listNoteNames(vaultRoot: string, parts: string[]): Promise<string[]> {
  const { dir, entries } = await readDir(vaultRoot, parts);
  const out: string[] = [];
  for (const e of entries) {
    if (!e.name.endsWith(".md")) continue;
    const name = e.name.slice(0, -3);
    if (isValidSlug(name) && (await kindOf(dir, e)) === "file") out.push(name);
  }
  return out.sort();
}

// Size/mtime of one note; undefined if it vanished or is no longer a regular file.
export async function statNote(vaultRoot: string, parts: string[], name: string): Promise<NoteInfo | undefined> {
  try {
    const st = await fsp.lstat(path.join(path.resolve(vaultRoot, ...parts), `${name}.md`));
    return st.isFile() ? { name, size: st.size, mtime: st.mtime } : undefined;
  } catch {
    return undefined;
  }
}

// Reads a regular file through a single fd opened with O_NOFOLLOW, so a path
// swapped for a symlink after enumeration is never followed (rejects with
// ELOOP). Returns undefined for non-regular or oversized files.
export async function readFileNoFollow(
  file: string,
  maxBytes: number,
): Promise<{ content: string; bytes: number } | undefined> {
  const fh = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return { content: buf.subarray(0, off).toString("utf8"), bytes: off };
  } finally {
    await fh.close();
  }
}
