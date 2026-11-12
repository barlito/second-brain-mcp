import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNoteNames, listSubdirs, readFileNoFollow } from "./enumerate";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "enum-"));
}

test("readFileNoFollow reads a regular file and refuses a symlink (ELOOP)", async () => {
  const d = tmp();
  try {
    writeFileSync(join(d, "real.md"), "hello");
    symlinkSync(join(d, "real.md"), join(d, "link.md"));
    assert.deepEqual(await readFileNoFollow(join(d, "real.md"), 100), { content: "hello", bytes: 5, raw: Buffer.from("hello") });
    await assert.rejects(readFileNoFollow(join(d, "link.md"), 100), { code: "ELOOP" });
    assert.equal(await readFileNoFollow(join(d, "real.md"), 2), undefined); // over the cap
    mkdirSync(join(d, "dir.md"));
    assert.equal(await readFileNoFollow(join(d, "dir.md"), 100), undefined); // not a regular file
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("DT_UNKNOWN entries fall back to lstat and still reject symlinks", async () => {
  const d = tmp();
  const orig = fsp.readdir;
  try {
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "n.md"), "x");
    symlinkSync(join(d, "sub"), join(d, "linkdir"));
    symlinkSync(join(d, "n.md"), join(d, "ln.md"));
    const unknown = (name: string) => ({
      name,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    });
    (fsp as { readdir: unknown }).readdir = async () => ["sub", "n.md", "linkdir", "ln.md"].map(unknown);
    assert.deepEqual(await listSubdirs(d, []), ["sub"]);
    assert.deepEqual(await listNoteNames(d, []), ["n"]);
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
    rmSync(d, { recursive: true, force: true });
  }
});
