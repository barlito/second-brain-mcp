import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScope } from "./check";
import type { Permission, Scope } from "../auth/types";

const sc = (space: string, project: string, section: string, permission: Permission): Scope => ({
  space,
  project,
  section,
  permission,
});

test("explicit scope matches only the exact space/project/section/permission", () => {
  const s = [sc("pro", "x", "y", "read")];
  assert.equal(checkScope(s, "pro", "x", "y", "read"), true);
  assert.equal(checkScope(s, "perso", "x", "y", "read"), false); // other space
  assert.equal(checkScope(s, "pro", "z", "y", "read"), false);
  assert.equal(checkScope(s, "pro", "x", "z", "read"), false);
  assert.equal(checkScope(s, "pro", "x", "y", "write"), false); // read does not imply write
});

test("space:project:* covers every section of that project only", () => {
  const s = [sc("pro", "x", "*", "write")];
  assert.equal(checkScope(s, "pro", "x", "anything", "write"), true);
  assert.equal(checkScope(s, "pro", "other", "anything", "write"), false);
  assert.equal(checkScope(s, "perso", "x", "anything", "write"), false);
  assert.equal(checkScope(s, "pro", "x", "anything", "read"), true); // write includes read
  assert.equal(checkScope(s, "pro", "other", "anything", "read"), false);
});

test("space:*:* covers one whole space, not others", () => {
  const s = [sc("pro", "*", "*", "read")];
  assert.equal(checkScope(s, "pro", "a", "b", "read"), true);
  assert.equal(checkScope(s, "pro", "c", "d", "read"), true);
  assert.equal(checkScope(s, "perso", "a", "b", "read"), false); // cross-space denial
  assert.equal(checkScope(s, "pro", "a", "b", "write"), false);
});

test("*:*:* covers everything for its permission only", () => {
  const ro = [sc("*", "*", "*", "read")];
  assert.equal(checkScope(ro, "perso", "a", "b", "read"), true);
  assert.equal(checkScope(ro, "meta", "c", "d", "read"), true);
  assert.equal(checkScope(ro, "perso", "a", "b", "write"), false);
  const rw = [sc("*", "*", "*", "read"), sc("*", "*", "*", "write")];
  assert.equal(checkScope(rw, "idees", "a", "b", "write"), true);
});

test("a token may hold scopes in several spaces; none leak into others", () => {
  const s = [sc("pro", "*", "*", "read"), sc("perso", "p", "s", "write")];
  assert.equal(checkScope(s, "pro", "a", "b", "read"), true);
  assert.equal(checkScope(s, "perso", "p", "s", "write"), true);
  assert.equal(checkScope(s, "perso", "p", "s", "read"), true); // write includes read
  assert.equal(checkScope(s, "pro", "a", "b", "write"), false);
  assert.equal(checkScope(s, "idees", "p", "s", "read"), false);
});

test("sentinel '!legacy' scopes match no valid space", () => {
  const s = [sc("!legacy", "p", "s", "read")];
  assert.equal(checkScope(s, "perso", "p", "s", "read"), false);
  assert.equal(checkScope(s, "legacy", "p", "s", "read"), false);
});

test("malformed stored wildcards (non-* after *) match nothing and warn once", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(String(m));
  try {
    const s = [sc("pro", "*", "secrets", "read"), sc("*", "x", "y", "read"), sc("*", "*", "y", "read")];
    assert.equal(checkScope(s, "pro", "p", "secrets", "read"), false);
    assert.equal(checkScope(s, "pro", "p", "secrets", "read"), false);
    assert.equal(checkScope(s, "any", "x", "y", "read"), false);
    assert.equal(warns.filter((w) => /pro:\*:secrets:read/.test(w)).length, 1);
    assert.equal(warns.length, 3);
  } finally {
    console.warn = orig;
  }
});

test("no scopes denies", () => {
  assert.equal(checkScope([], "pro", "x", "y", "read"), false);
});

test("write includes read, propose does not, read never implies write", () => {
  const w = [sc("pro", "x", "y", "write")];
  assert.equal(checkScope(w, "pro", "x", "y", "read"), true);
  assert.equal(checkScope(w, "pro", "x", "z", "read"), false);
  const p = [sc("pro", "x", "y", "propose")];
  assert.equal(checkScope(p, "pro", "x", "y", "read"), false);
  assert.equal(checkScope(p, "pro", "x", "y", "write"), false);
  assert.equal(checkScope([sc("pro", "x", "y", "read")], "pro", "x", "y", "write"), false);
});
