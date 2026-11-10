import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { isValidSlug, resolveNotePath, resolveSectionDir } from "./paths";

const vaultRoot = "/vault";

test("isValidSlug accepts valid slugs", () => {
  assert.equal(isValidSlug("a"), true);
  assert.equal(isValidSlug("project-1"), true);
  assert.equal(isValidSlug("a".repeat(64)), true);
});

test("isValidSlug rejects invalid slugs", () => {
  assert.equal(isValidSlug(""), false);
  assert.equal(isValidSlug("Project"), false); // uppercase
  assert.equal(isValidSlug("-project"), false); // leading hyphen
  assert.equal(isValidSlug(".."), false);
  assert.equal(isValidSlug("a/b"), false);
  assert.equal(isValidSlug("../../etc/passwd"), false);
  assert.equal(isValidSlug("a".repeat(65)), false); // over 64 chars
});

test("resolveNotePath resolves to the expected path for valid input", () => {
  const result = resolveNotePath(vaultRoot, "proj", "sect", "note");
  assert.equal(result, path.resolve(vaultRoot, "proj", "sect", "note.md"));
});

test("resolveSectionDir resolves to the expected path for valid input", () => {
  const result = resolveSectionDir(vaultRoot, "proj", "sect");
  assert.equal(result, path.resolve(vaultRoot, "proj", "sect"));
});

test("resolveNotePath throws before touching the filesystem for malicious project", () => {
  assert.throws(() => resolveNotePath(vaultRoot, "../../etc", "sect", "note"), /invalid project slug/);
});

test("resolveNotePath throws for malicious section", () => {
  assert.throws(() => resolveNotePath(vaultRoot, "proj", "..", "note"), /invalid section slug/);
});

test("resolveNotePath throws for malicious note", () => {
  assert.throws(() => resolveNotePath(vaultRoot, "proj", "sect", "../../../etc/passwd"), /invalid note slug/);
  assert.throws(() => resolveNotePath(vaultRoot, "proj", "sect", "a/b"), /invalid note slug/);
});

test("resolveSectionDir throws for malicious input", () => {
  assert.throws(() => resolveSectionDir(vaultRoot, "proj", "../../etc"), /invalid section slug/);
  assert.throws(() => resolveSectionDir(vaultRoot, "", "sect"), /invalid project slug/);
});
