import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, lineAt, NoteRef, parseLinks } from "./links";
import { docsMapPaths } from "./docsMap";

const targets = (t: string) => parseLinks(t).map((l) => l.target);

test("parses plain, alias, heading, heading+alias and embed links", () => {
  const t = "a [[one]] b [[two|Two]] c [[three#H 1]] d [[four#h|Four]] e ![[five.png]]";
  const l = parseLinks(t);
  assert.deepEqual(l.map((x) => x.target), ["one", "two", "three", "four", "five.png"]);
  assert.equal(l[1].alias, "Two");
  assert.equal(l[2].heading, "H 1");
  assert.equal(l[3].heading, "h");
  assert.equal(l[3].alias, "Four");
  assert.deepEqual(l.map((x) => x.embed), [false, false, false, false, true]);
});

test("offsets point at the link and at the target part", () => {
  const t = "xx [[ notes/a#h | al ]] yy";
  const [l] = parseLinks(t);
  assert.equal(t.slice(l.start, l.end), "[[ notes/a#h | al ]]");
  assert.equal(l.raw, "[[ notes/a#h | al ]]");
  assert.equal(t.slice(l.targetStart, l.targetEnd), "notes/a");
  assert.equal(l.target, "notes/a");
  assert.equal(lineAt("l1\n  see [[x]]  \nl3", 8), "see [[x]]");
});

test("ignores fenced code, inline code and frontmatter; offsets stay valid", () => {
  const t = [
    "---",
    "related: '[[in-fm]]'",
    "---",
    "[[kept1]] `[[inline]]` ``a ` [[inline2]]`` [[kept2]]",
    "```js",
    "[[fenced]]",
    "```",
    "~~~~",
    "[[tilde]]",
    "~~~",
    "[[still-tilde]]",
    "~~~~",
    "[[kept3]]",
    "```",
    "[[unclosed]]",
  ].join("\n");
  const l = parseLinks(t);
  assert.deepEqual(l.map((x) => x.target), ["kept1", "kept2", "kept3"]);
  for (const x of l) assert.equal(t.slice(x.start, x.end), x.raw);
});

test("skips empty targets and same-note heading links; CRLF frontmatter", () => {
  assert.deepEqual(targets("[[#h]] [[|x]] [[ ]] [[ok]]"), ["ok"]);
  assert.deepEqual(targets("---\r\na: [[x]]\r\n---\r\n[[y]]"), ["y"]);
});

const n = (space: string, project: string, section: string, name: string): NoteRef => ({ space, project, section, name });

test("resolver: 1-part name goes project, then space, then vault", () => {
  const notes = [
    n("s", "p", "notes", "a"),
    n("s", "q", "notes", "a"),
    n("s", "q", "notes", "only-space"),
    n("t", "z", "notes", "only-vault"),
    n("s", "p", "notes", "dup"),
    n("s", "p", "decisions", "dup"),
  ];
  const r = createResolver(notes);
  const from = { space: "s", project: "p" };
  assert.deepEqual(r(from, "a"), { status: "resolved", note: notes[0] });
  assert.deepEqual(r(from, "only-space"), { status: "resolved", note: notes[2] });
  assert.deepEqual(r(from, "only-vault"), { status: "resolved", note: notes[3] });
  assert.deepEqual(r(from, "nope"), { status: "missing" });
  const amb = r(from, "dup");
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.status === "ambiguous" && amb.candidates.length, 2);
  // Two matches at the vault level are ambiguous too.
  assert.equal(r({ space: "x", project: "y" }, "a").status, "ambiguous");
});

test("resolver: 2, 3 and 4-part targets, .md suffix, case, archive excluded", () => {
  const notes = [n("s", "p", "notes", "a"), n("s", "q", "conventions", "c"), n("t", "z", "notes", "w"), n("s", "p", "archive", "old")];
  const r = createResolver(notes);
  const from = { space: "s", project: "p" };
  assert.equal(r(from, "notes/a").status, "resolved");
  assert.equal(r(from, "notes/a.md").status, "resolved");
  assert.equal(r(from, "Notes/A").status, "resolved");
  assert.equal(r(from, "conventions/c").status, "missing"); // other project
  assert.equal(r(from, "q/conventions/c").status, "resolved");
  assert.equal(r(from, "z/notes/w").status, "missing"); // other space
  assert.equal(r(from, "t/z/notes/w").status, "resolved");
  assert.equal(r(from, "old").status, "missing");
  assert.equal(r(from, "archive/old").status, "missing");
  assert.equal(r(from, "s/p/archive/old").status, "missing");
  assert.equal(r(from, "a/b/c/d/e").status, "missing");
});

test("docs map: backticked names under a section bullet, slash paths as written", () => {
  const body = [
    "# x",
    "## Docs map",
    "- `decisions`",
    "  - `git-source-de-verite` : why",
    "- `notes`",
    "  - `roadmap` : features",
    "    - `deeper`",
    "- `journal` : monthly",
    "- `notes/direct`",
    "## Other",
    "- `x`",
    "  - `y`",
  ].join("\n");
  assert.deepEqual(docsMapPaths(body), ["decisions/git-source-de-verite", "notes/roadmap", "roadmap/deeper", "notes/direct"]);
  assert.deepEqual(docsMapPaths("no map here"), []);
});
