import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, noteKey, NoteRef } from "../vault/links";
import { moveDocsMapEntry } from "../vault/docsMap";
import { linkTarget, rewriteLinks } from "./moveLinks";

const n = (key: string): NoteRef => {
  const [space, project, section, name] = key.split("/");
  return { space, project, section, name };
};

// Moves `from` to `to` among `keys`, rewriting `text` written in `linker`.
function move(keys: string[], from: string, to: string, linker: string, text: string): string {
  const notes = keys.map(n);
  const resolveBefore = createResolver(notes);
  const resolveAfter = createResolver([...notes.filter((x) => noteKey(x) !== from), n(to)]);
  const at = n(linker);
  return rewriteLinks(text, { before: at, after: at, resolveBefore, resolveAfter, retarget: (x) => (noteKey(x) === from ? n(to) : undefined) }).text;
}

test("rewrite keeps the part count when unique, else the shortest unique form", () => {
  const base = ["pro/a/notes/old", "pro/a/notes/l", "pro/a/decisions/dup", "pro/b/notes/far", "pro/c/notes/far", "perso/x/notes/z", "home/y/notes/z"];
  const rows: Array<[string, string, string, string]> = [
    // [to, linker, before, after]
    ["pro/a/notes/new", "pro/a/notes/l", "[[old]]", "[[new]]"],
    ["pro/a/notes/new", "pro/a/notes/l", "[[notes/old]] [[a/notes/old]] [[pro/a/notes/old]]", "[[notes/new]] [[a/notes/new]] [[pro/a/notes/new]]"],
    ["pro/a/conventions/dup", "pro/a/notes/l", "[[old]]", "[[conventions/dup]]"],
    ["pro/b/notes/far", "pro/a/notes/l", "[[old]]", "[[b/notes/far]]"],
    ["perso/q/notes/z", "pro/a/notes/l", "[[old]]", "[[perso/q/notes/z]]"],
    ["pro/a/notes/new", "pro/a/notes/l", "x [[old#Head|Alias]] ![[old]] [[ old ]] [[old\\|t]] [[OLD.md]]", "x [[new#Head|Alias]] ![[new]] [[ new ]] [[new\\|t]] [[new]]"],
    ["pro/a/notes/new", "pro/a/notes/l", "`[[old]]`\n```\n[[old]]\n```\n[[other]]", "`[[old]]`\n```\n[[old]]\n```\n[[other]]"],
  ];
  for (const [to, linker, before, after] of rows) {
    const keys = to === "pro/b/notes/far" ? base.filter((k) => k !== "pro/b/notes/far") : base;
    assert.equal(move(keys, "pro/a/notes/old", to, linker, before), after, `${to}: ${before}`);
  }
});

test("a 1-part link that still resolves after a section change is left alone", () => {
  assert.equal(move(["pro/a/notes/old", "pro/a/notes/l"], "pro/a/notes/old", "pro/a/decisions/old", "pro/a/notes/l", "[[old]]"), "[[old]]");
});

test("linkTarget from another project needs 3 parts, from another space 4", () => {
  const r = createResolver([n("pro/b/notes/t"), n("pro/c/notes/t")]);
  assert.equal(linkTarget(r, { space: "pro", project: "a" }, n("pro/b/notes/t"), 1), "b/notes/t");
  assert.equal(linkTarget(r, { space: "x", project: "y" }, n("pro/b/notes/t"), 2), "pro/b/notes/t");
  assert.equal(linkTarget(r, { space: "pro", project: "b" }, n("pro/b/notes/t"), 4), "pro/b/notes/t");
});

test("moveDocsMapEntry renames, moves under the destination bullet, or reports", () => {
  const idx = "# p\n\n## Docs map\n- `notes`\n  - `a` : first\n  - `b`\n- `decisions`\n  - `d`\n- `x/y`\n\n## Other\n- `notes`\n";
  assert.equal(moveDocsMapEntry(idx, "notes/zz", "notes/a2"), undefined);
  assert.equal(moveDocsMapEntry(idx, "notes/a", "notes/a2")?.text, idx.replace("`a` : first", "`a2` : first"));
  assert.equal(
    moveDocsMapEntry(idx, "notes/a", "decisions/a2")?.text,
    "# p\n\n## Docs map\n- `notes`\n  - `b`\n- `decisions`\n  - `d`\n  - `a2` : first\n- `x/y`\n\n## Other\n- `notes`\n",
  );
  assert.equal(moveDocsMapEntry(idx, "x/y", "notes/y")?.text, idx.replace("`x/y`", "`notes/y`"));
  const none = moveDocsMapEntry(idx, "notes/b", "guides/b");
  assert.equal(none?.text, undefined);
  assert.match(none!.change, /no `guides` bullet/);
  const empty = "## Docs map\n- `notes`\n  - `a`\n- `decisions`\n";
  assert.equal(moveDocsMapEntry(empty, "notes/a", "decisions/a")?.text, "## Docs map\n- `notes`\n- `decisions`\n  - `a`\n");
});
