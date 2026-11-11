import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { UnsafePathError, resolveNotePath, resolveSectionDir } from "./paths";

function withTree(fn: (root: string, outside: string) => void): void {
  const base = mkdtempSync(path.join(tmpdir(), "second-brain-paths-test-"));
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "sp", "projb", "notes"), { recursive: true });
  mkdirSync(path.join(root, "sp", "proja"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.md"), "secret");
  try {
    fn(root, outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("rejects a section dir symlinked to a sibling project", () => {
  withTree((root) => {
    symlinkSync(path.join(root, "sp", "projb", "notes"), path.join(root, "sp", "proja", "notes"));
    assert.throws(() => resolveNotePath(root, "sp", "proja", "notes", "x"), /symlink/);
    assert.throws(() => resolveSectionDir(root, "sp", "proja", "notes"), /symlink/);
  });
});

test("rejects a project dir symlinked outside the vault", () => {
  withTree((root, outside) => {
    symlinkSync(outside, path.join(root, "sp", "evil"));
    assert.throws(() => resolveNotePath(root, "sp", "evil", "notes", "secret"), /symlink/);
  });
});

test("rejects a note symlinked outside the vault, even dangling", () => {
  withTree((root, outside) => {
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "sp", "projb", "notes", "n.md"));
    symlinkSync(path.join(outside, "nope.md"), path.join(root, "sp", "projb", "notes", "d.md"));
    assert.throws(() => resolveNotePath(root, "sp", "projb", "notes", "n"), /symlink/);
    assert.throws(() => resolveNotePath(root, "sp", "projb", "notes", "d"), /symlink/);
  });
});

test("path rejections throw UnsafePathError (symlink and non-regular file)", () => {
  withTree((root, outside) => {
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "sp", "projb", "notes", "n.md"));
    assert.throws(() => resolveNotePath(root, "sp", "projb", "notes", "n"), UnsafePathError);
    mkdirSync(path.join(root, "sp", "projb", "notes", "dir.md"));
    assert.throws(() => resolveNotePath(root, "sp", "projb", "notes", "dir"), UnsafePathError);
  });
});

test("accepts regular and not-yet-existing notes", () => {
  withTree((root) => {
    writeFileSync(path.join(root, "sp", "projb", "notes", "ok.md"), "x");
    assert.equal(resolveNotePath(root, "sp", "projb", "notes", "ok"), path.join(root, "sp", "projb", "notes", "ok.md"));
    assert.doesNotThrow(() => resolveNotePath(root, "sp", "newproj", "newsect", "new"));
  });
});

test("rejects a space dir symlinked outside the vault, or to another space", () => {
  withTree((root, outside) => {
    symlinkSync(outside, path.join(root, "evilspace"));
    assert.throws(() => resolveNotePath(root, "evilspace", "p", "s", "secret"), /symlink/);
    assert.throws(() => resolveSectionDir(root, "evilspace", "p", "s"), /symlink/);
    symlinkSync(path.join(root, "sp"), path.join(root, "alias"));
    assert.throws(() => resolveNotePath(root, "alias", "proja", "notes", "x"), UnsafePathError);
  });
});
