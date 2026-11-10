import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveNotePath, resolveSectionDir } from "./paths";

function withTree(fn: (root: string, outside: string) => void): void {
  const base = mkdtempSync(path.join(tmpdir(), "second-brain-paths-test-"));
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "projb", "notes"), { recursive: true });
  mkdirSync(path.join(root, "proja"), { recursive: true });
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
    symlinkSync(path.join(root, "projb", "notes"), path.join(root, "proja", "notes"));
    assert.throws(() => resolveNotePath(root, "proja", "notes", "x"), /symlink/);
    assert.throws(() => resolveSectionDir(root, "proja", "notes"), /symlink/);
  });
});

test("rejects a project dir symlinked outside the vault", () => {
  withTree((root, outside) => {
    symlinkSync(outside, path.join(root, "evil"));
    assert.throws(() => resolveNotePath(root, "evil", "notes", "secret"), /symlink/);
  });
});

test("rejects a note symlinked outside the vault, even dangling", () => {
  withTree((root, outside) => {
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "projb", "notes", "n.md"));
    symlinkSync(path.join(outside, "nope.md"), path.join(root, "projb", "notes", "d.md"));
    assert.throws(() => resolveNotePath(root, "projb", "notes", "n"), /symlink/);
    assert.throws(() => resolveNotePath(root, "projb", "notes", "d"), /symlink/);
  });
});

test("accepts regular and not-yet-existing notes", () => {
  withTree((root) => {
    writeFileSync(path.join(root, "projb", "notes", "ok.md"), "x");
    assert.equal(resolveNotePath(root, "projb", "notes", "ok"), path.join(root, "projb", "notes", "ok.md"));
    assert.doesNotThrow(() => resolveNotePath(root, "newproj", "newsect", "new"));
  });
});
