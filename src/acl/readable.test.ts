import { test } from "node:test";
import assert from "node:assert/strict";
import { canReadUnderProject, canReadUnderSpace } from "./readable";
import type { Permission, Scope } from "../auth/types";

const sc = (space: string, project: string, section: string, permission: Permission = "read"): Scope => ({
  space,
  project,
  section,
  permission,
});

test("*:*:* reads under any space and project", () => {
  const s = [sc("*", "*", "*")];
  assert.equal(canReadUnderSpace(s, "pro"), true);
  assert.equal(canReadUnderProject(s, "pro", "x"), true);
});

test("space:*:* reads under that space only", () => {
  const s = [sc("pro", "*", "*")];
  assert.equal(canReadUnderSpace(s, "pro"), true);
  assert.equal(canReadUnderSpace(s, "perso"), false);
  assert.equal(canReadUnderProject(s, "pro", "x"), true);
  assert.equal(canReadUnderProject(s, "perso", "x"), false);
});

test("space:project:* and explicit scopes narrow to their project", () => {
  for (const s of [[sc("pro", "x", "*")], [sc("pro", "x", "notes")]]) {
    assert.equal(canReadUnderSpace(s, "pro"), true);
    assert.equal(canReadUnderSpace(s, "perso"), false);
    assert.equal(canReadUnderProject(s, "pro", "x"), true);
    assert.equal(canReadUnderProject(s, "pro", "y"), false);
    assert.equal(canReadUnderProject(s, "perso", "x"), false);
  }
});

test("malformed stored scopes (mid-level '*') grant nothing", () => {
  for (const s of [sc("*", "x", "y"), sc("pro", "*", "y"), sc("*", "*", "y"), sc("*", "x", "*")]) {
    assert.equal(canReadUnderSpace([s], "pro"), false, JSON.stringify(s));
    assert.equal(canReadUnderProject([s], "pro", "x"), false, JSON.stringify(s));
  }
});

test("mixed scopes: any matching read scope is enough", () => {
  const s = [sc("pro", "x", "notes"), sc("perso", "*", "*"), sc("idees", "*", "*", "write")];
  assert.equal(canReadUnderSpace(s, "pro"), true);
  assert.equal(canReadUnderSpace(s, "perso"), true);
  assert.equal(canReadUnderSpace(s, "idees"), true); // write includes read
  assert.equal(canReadUnderProject(s, "pro", "z"), false);
});

test("no scopes grants nothing", () => {
  assert.equal(canReadUnderSpace([], "pro"), false);
  assert.equal(canReadUnderProject([], "pro", "x"), false);
});

test("write scopes count as readable, propose does not", () => {
  const w = [sc("pro", "x", "*", "write")];
  assert.equal(canReadUnderSpace(w, "pro"), true);
  assert.equal(canReadUnderProject(w, "pro", "x"), true);
  assert.equal(canReadUnderProject(w, "pro", "z"), false);
  const p = [sc("pro", "x", "*", "propose")];
  assert.equal(canReadUnderSpace(p, "pro"), false);
  assert.equal(canReadUnderProject(p, "pro", "x"), false);
});
