import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDb } from "../test-support/fixtures";

makeTempDb();
// conventions pulls in db.ts, which reads DB_PATH at import time.
const { normalizeNote, fillMissingFrontmatter, searchView, parseNote } = require("./frontmatter") as typeof import("./frontmatter");
const { NoteRuleError } = require("./conventions") as typeof import("./conventions");

const base = { author: "tok", today: "2026-11-12", existing: null as string | null };
const norm = (content: string, section = "notes", over: Partial<Parameters<typeof normalizeNote>[1]> = {}) =>
  normalizeNote(content, { section, ...base, ...over });

test("plain body gets default frontmatter with stable key order", () => {
  assert.equal(norm("# Hi\n"), "---\ntype: note\nauthor: tok\ncreated: 2026-11-12\nupdated: 2026-11-12\n---\n# Hi\n");
  assert.match(norm("x", "decisions"), /^---\ntype: decision\n/);
  assert.match(norm("x", "conventions"), /^---\ntype: convention\n/);
  assert.match(norm("x", "custom"), /^---\ntype: note\n/);
});

test("server-owned fields from the client are ignored; unknown keys preserved after the known ones", () => {
  const out = norm("---\nzeta: 1\nauthor: evil\ncreated: 1999-01-01\nupdated: 1999-01-01\nsources: [a, b]\ntype: guide\ntags: [x]\n---\nbody\n");
  assert.equal(
    out,
    "---\ntype: guide\nsources: [a, b]\nauthor: tok\ncreated: 2026-11-12\nupdated: 2026-11-12\nzeta: 1\ntags: [x]\n---\nbody\n",
  );
});

test("created is preserved from the existing note", () => {
  const first = norm("a\n", "notes", { today: "2026-01-01", author: "one" });
  const second = norm("b\n", "notes", { existing: first });
  assert.match(second, /author: tok\ncreated: 2026-01-01\nupdated: 2026-11-12\n/);
});

test("unchanged body and client fields return the existing text (no updated bump)", () => {
  const first = norm("---\nsources: [s]\nfoo: bar\n---\nbody\n", "notes", { today: "2026-01-01", author: "one" });
  const again = norm("---\nfoo: bar\nsources: [s]\nauthor: other\n---\nbody\n", "notes", { existing: first });
  assert.equal(again, first);
  assert.notEqual(norm("---\nfoo: bar\nsources: [s]\n---\nbody2\n", "notes", { existing: first }), first);
  assert.notEqual(norm("---\nfoo: baz\nsources: [s]\n---\nbody\n", "notes", { existing: first }), first);
});

test("type validation per section", () => {
  const err = (c: string, s: string) => assert.throws(() => norm(c, s), (e) => e instanceof NoteRuleError && /Invalid frontmatter/.test(e.message));
  err("---\ntype: bogus\n---\nx", "notes");
  err("---\ntype: guide\n---\nx", "decisions");
  err("---\ntype: note\n---\nx", "conventions");
  err("---\ntype: decision\n---\nx", "notes");
  err("---\ntype: 3\n---\nx", "notes");
  for (const t of ["note", "guide", "reference", "gotcha"]) assert.match(norm(`---\ntype: ${t}\n---\nx`, "notes"), new RegExp(`type: ${t}\\n`));
  assert.match(norm("---\ntype: decision\n---\nx", "decisions"), /type: decision/);
});

test("sources validation", () => {
  const err = (fm: string) => assert.throws(() => norm(`---\n${fm}\n---\nx`), NoteRuleError);
  err("sources: nope");
  err("sources: [1]");
  err("sources: ['']");
  err(`sources: ['${"a".repeat(501)}']`);
  err(`sources: [${Array.from({ length: 21 }, (_, i) => `s${i}`).join(",")}]`);
  assert.match(norm(`---\nsources: [${Array.from({ length: 20 }, (_, i) => `s${i}`).join(",")}]\n---\nx`), /sources: \[s0/);
});

test("malformed / non-mapping / unterminated frontmatter is rejected", () => {
  for (const c of ["---\na: [\n---\nx", "---\n- a\n- b\n---\nx", "---\njust text\n---\nx", "---\na: 1\nno close", "---\na: &x 1\nb: *x\n---\nx", "---\na: 1\na: 2\n---\nx"]) {
    assert.throws(() => norm(c), NoteRuleError, c);
  }
});

test("sections without frontmatter pass through verbatim", () => {
  for (const s of ["overview", "journal", "archive"]) assert.equal(norm("# plain\n", s), "# plain\n");
});

test("parseNote and searchView", () => {
  assert.deepEqual(parseNote("no fm"), { present: false, doc: null, data: {}, body: "no fm" });
  assert.equal(parseNote("---\r\na: 1\r\n---\r\nbody").body, "body");
  assert.equal(searchView("notes", "---\ntype: gotcha\n---\nx").type, "gotcha");
  assert.equal(searchView("notes", "---\ntype: gotcha\n---\nx").body, "x");
  assert.equal(searchView("notes", "---\ntype: nope\n---\nx").type, undefined);
  assert.equal(searchView("notes", "---\nbroken: [\n---\nx").body, "---\nbroken: [\n---\nx");
  assert.equal(searchView("journal", "---\nt: a\n---\nx").body, "---\nt: a\n---\nx");
});

const FM = "---\ntype: guide\nsources: [s]\nfoo: bar\n---\nold\n";

test("content without frontmatter inherits type, sources and extras from the existing note", () => {
  const first = norm(FM, "notes", { today: "2026-01-01", author: "one" });
  const out = norm("new body\n", "notes", { existing: first });
  assert.equal(out, "---\ntype: guide\nsources: [s]\nauthor: tok\ncreated: 2026-01-01\nupdated: 2026-11-12\nfoo: bar\n---\nnew body\n");
  // Same body again: still no change.
  assert.equal(norm("old\n", "notes", { existing: first }), first);
  // Frontmatter in the new content replaces the client fields.
  assert.doesNotMatch(norm("---\ntype: note\n---\nz\n", "notes", { existing: first }), /foo|sources/);
  // An inherited value this section refuses falls back to the default.
  const odd = "---\ntype: guide\nauthor: a\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\nb\n";
  assert.match(norm("c\n", "decisions", { existing: odd }), /^---\ntype: decision\n/);
});

test("a leading BOM is tolerated and dropped; no second block", () => {
  const out = norm("\uFEFF---\nfoo: 1\n---\nbody\n");
  assert.equal(out, "---\ntype: note\nauthor: tok\ncreated: 2026-11-12\nupdated: 2026-11-12\nfoo: 1\n---\nbody\n");
  assert.equal(norm("\uFEFFplain\n").split("---").length, 3);
  assert.equal(fillMissingFrontmatter("\uFEFF---\nfoo: 1\n---\nb\n", { section: "notes", author: "migration", created: "2020-01-01", updated: "2021-01-01" }).split("---").length, 3);
});

test("extras survive losslessly: numbers, big ints, comments, __proto__, order", () => {
  const out = norm("---\nver: 1.10\nhex: 0x1F\nbig: 12345678901234567890\n# keep me\nnote2: x # trailing\n__proto__: y\n---\nb\n");
  assert.match(out, /ver: 1\.10\nhex: 0x1F\nbig: 12345678901234567890\n# keep me\nnote2: x # trailing\n__proto__: y\n---\nb\n$/);
  assert.match(out, /^---\ntype: note\nauthor: tok\ncreated: 2026-11-12\nupdated: 2026-11-12\nver:/);
  // And a rewrite of the result is a no change.
  assert.equal(norm("---\nver: 1.10\nhex: 0x1F\nbig: 12345678901234567890\n# keep me\nnote2: x # trailing\n__proto__: y\n---\nb\n", "notes", { existing: out }), out);
});

test("created: ISO datetime kept as written; incomplete server fields count as a change", () => {
  const existing = "---\ntype: note\ncreated: 2020-02-02T10:00:00Z\n---\nb\n";
  const out = norm("b\n", "notes", { existing });
  assert.match(out, /author: tok\ncreated: 2020-02-02T10:00:00Z\nupdated: 2026-11-12\n/);
  assert.equal(norm("b\n", "notes", { existing: out }), out);
  const noAuthor = "---\ntype: note\ncreated: 2020-02-02\nupdated: 2020-02-02\n---\nb\n";
  assert.match(norm("b\n", "notes", { existing: noAuthor }), /author: tok\ncreated: 2020-02-02\nupdated: 2026-11-12/);
});

test("CRLF body gets CRLF frontmatter", () => {
  assert.equal(norm("a\r\nb\r\n"), "---\r\ntype: note\r\nauthor: tok\r\ncreated: 2026-11-12\r\nupdated: 2026-11-12\r\n---\r\na\r\nb\r\n");
  const crlf = norm("a\r\n");
  assert.equal(norm("a\r\n", "notes", { existing: crlf }), crlf);
});

test("fillMissingFrontmatter completes only what is missing", () => {
  const o = { section: "notes", author: "migration", created: "2020-01-01", updated: "2021-01-01" };
  const out = fillMissingFrontmatter("---\ntags: [a]\ncreated: 2019-05-05\n---\nb\n", o);
  assert.equal(out, "---\ntype: note\nauthor: migration\ncreated: 2019-05-05\nupdated: 2021-01-01\ntags: [a]\n---\nb\n");
  assert.equal(fillMissingFrontmatter(out, o), out);
  assert.equal(fillMissingFrontmatter("plain\n", o), "---\ntype: note\nauthor: migration\ncreated: 2020-01-01\nupdated: 2021-01-01\n---\nplain\n");
});
