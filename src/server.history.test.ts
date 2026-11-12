import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let app: Awaited<ReturnType<typeof listen>>;
let rw: string;
let ro: string;
let other: string;
let createTok: typeof import("./auth/tokens").createToken;
const base = { space: "pro", project: "proj" };

before(async () => {
  const { createToken } = await import("./auth/tokens");
  createTok = createToken;
  const { createApp } = await import("./server");
  rw = createToken("agent-rw", [
    { space: "pro", project: "*", section: "*", permission: "write" },
    { space: "pro", project: "*", section: "*", permission: "read" },
  ]).token;
  ro = createToken("agent-ro", [{ space: "pro", project: "*", section: "*", permission: "read" }]).token;
  other = createToken("agent-other", [{ space: "pro", project: "proj", section: "journal", permission: "read" }]).token;
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const call = (tok: string, name: string, args: Record<string, unknown>) => callTool(app.baseUrl, tok, name, args);
const target = { ...base, section: "notes", note: "hist" };

test("kb_history lists write commits newest first, then follows the archive rename", async () => {
  assert.equal((await call(rw, "kb_write", { ...target, content: "v1\n" })).isError, false);
  assert.equal((await call(rw, "kb_write", { ...target, content: "v2\n" })).isError, false);

  const h = await call(ro, "kb_history", target);
  assert.equal(h.isError, false);
  const [head, ...lines] = h.text.split("\n");
  assert.equal(head, "path: pro/proj/notes/hist.md");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.match(l, /^[0-9a-f]{7,} \d{4}-\d\d-\d\dT\S+ kb_write: pro\/proj\/notes\/hist via agent-rw/);
  }

  const arch = await call(rw, "kb_archive", target);
  assert.equal(arch.isError, false, arch.text);
  const archivedNote = arch.text.split("/").pop()!.replace(/\.md$/, "");
  const ah = await call(rw, "kb_history", { ...base, section: "archive", note: archivedNote });
  assert.equal(ah.isError, false);
  assert.match(ah.text, /^path: pro\/proj\/archive\//);
  // archive commit + both writes, via --follow
  const alines = ah.text.split("\n").slice(1);
  assert.equal(alines.length, 3);
  assert.match(alines[0], /kb_archive/);
  assert.match(alines[2], /kb_write/);
});

test("kb_history on an appended journal note, with limit", async () => {
  const j = { ...base, section: "journal", note: "2026-11" };
  for (const e of ["a", "b", "c"]) assert.equal((await call(rw, "kb_append", { ...j, entry: e })).isError, false);
  const all = await call(rw, "kb_history", j);
  assert.equal(all.text.split("\n").length, 4);
  assert.match(all.text, /kb_append/);
  const one = await call(rw, "kb_history", { ...j, limit: 1 });
  assert.equal(one.text.split("\n").length, 2);
  assert.equal((await call(rw, "kb_history", { ...j, limit: 0 })).isError, true);
  assert.equal((await call(rw, "kb_history", { ...j, limit: 101 })).isError, true);
});

test("kb_history: ACL denial, invalid slug, unknown note", async () => {
  assert.deepEqual(await call(other, "kb_history", target), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(ro, "kb_history", { ...target, note: "never-existed" }), {
    isError: true,
    text: "Note not found.",
  });
  assert.deepEqual(await call(ro, "kb_history", { ...target, note: "../etc" }), {
    isError: true,
    text: "Invalid space/project/section/note name.",
  });
});

// Commits a hand-made rename (what Obsidian, a manual move or an inbox accept looks like).
function moveInVault(from: string, to: string): void {
  mkdirSync(path.dirname(path.join(vault, to)), { recursive: true });
  git(["mv", from, to], vault);
  git(["commit", "-m", `move ${from} -> ${to}`], vault);
}
const NOTICE = "(earlier history not accessible with this token)";

test("kb_history stops at a move out of an unreadable section", async () => {
  const src = { ...base, section: "notes", note: "mover" };
  assert.equal((await call(rw, "kb_write", { ...src, content: "a\n" })).isError, false);
  moveInVault("pro/proj/notes/mover.md", "pro/proj/ideas/mover.md");
  assert.equal((await call(rw, "kb_write", { ...base, section: "ideas", note: "mover", content: "b\n" })).isError, false);

  const ideasOnly = createTok("ideas-only", [{ space: "pro", project: "proj", section: "ideas", permission: "read" }]).token;
  const h = await call(ideasOnly, "kb_history", { ...base, section: "ideas", note: "mover" });
  assert.equal(h.isError, false, h.text);
  const lines = h.text.split("\n");
  assert.equal(lines.length, 4, h.text); // path, write, move, notice
  assert.match(lines[1], /kb_write/);
  assert.match(lines[2], /move pro\/proj\/notes\/mover\.md/);
  assert.equal(lines[3], NOTICE);
  assert.doesNotMatch(h.text, /kb_write: pro\/proj\/notes/);

  const full = await call(rw, "kb_history", { ...base, section: "ideas", note: "mover" });
  assert.equal(full.text.split("\n").length, 4, full.text);
  assert.doesNotMatch(full.text, /not accessible/);
  assert.match(full.text, /kb_write: pro\/proj\/notes\/mover/);
});

test("kb_history on an archived note with read on archive only hides pre-archive commits", async () => {
  const t = { ...base, section: "notes", note: "arch-me" };
  assert.equal((await call(rw, "kb_write", { ...t, content: "x\n" })).isError, false);
  const arch = await call(rw, "kb_archive", t);
  assert.equal(arch.isError, false, arch.text);
  const archivedNote = arch.text.split("/").pop()!.replace(/\.md$/, "");
  const archOnly = createTok("arch-only", [{ space: "pro", project: "proj", section: "archive", permission: "read" }]).token;
  const h = await call(archOnly, "kb_history", { ...base, section: "archive", note: archivedNote });
  assert.equal(h.isError, false, h.text);
  const lines = h.text.split("\n");
  assert.equal(lines.length, 3, h.text);
  assert.match(lines[1], /kb_archive/);
  assert.equal(lines[2], NOTICE);
});

test("kb_history of an inbox-accepted note stops before _inbox", async () => {
  mkdirSync(path.join(vault, "_inbox"), { recursive: true });
  writeFileSync(path.join(vault, "_inbox", "p1.md"), "proposal\n");
  git(["add", "_inbox/p1.md"], vault);
  git(["commit", "-m", "propose"], vault);
  moveInVault("_inbox/p1.md", "pro/proj/notes/accepted.md");
  const h = await call(rw, "kb_history", { ...base, section: "notes", note: "accepted" });
  assert.equal(h.isError, false, h.text);
  const lines = h.text.split("\n");
  assert.equal(lines.length, 2, h.text); // the accept is the note's creation: no notice
  assert.match(lines[1], /move _inbox\/p1\.md/);
});

const TEMPLATE = "# Overview\n\n## Goals\n\n- \n\n## Context\n\n- \n\n## Decisions\n\n- \n\n## Open questions\n\n- \n";

test("kb_history does not follow a copy from another note made from the same template", async () => {
  const a = { space: "pro", project: "alpha", section: "overview", note: "index" };
  const b = { space: "pro", project: "beta", section: "overview", note: "index" };
  assert.equal((await call(rw, "kb_write", { ...a, content: TEMPLATE + "alpha\n" })).isError, false);
  assert.equal((await call(rw, "kb_write", { ...a, content: TEMPLATE + "alpha v2\n" })).isError, false);
  assert.equal((await call(rw, "kb_write", { ...b, content: TEMPLATE + "beta\n" })).isError, false);
  const h = await call(ro, "kb_history", b);
  assert.equal(h.isError, false, h.text);
  const lines = h.text.split("\n");
  assert.equal(lines.length, 2, h.text);
  assert.match(lines[1], /kb_write: pro\/beta\/overview\/index/);
  // A token that cannot read alpha must not get the spurious notice either.
  const betaOnly = createTok("beta-only", [{ space: "pro", project: "beta", section: "*", permission: "read" }]).token;
  const hb = await call(betaOnly, "kb_history", b);
  assert.equal(hb.text.split("\n").length, 2, hb.text);
  assert.doesNotMatch(hb.text, /not accessible/);
  // Master view (admin): only beta's commit, at beta's path.
  const { noteHistory } = await import("./vault/git");
  const { entries } = await noteHistory(vault, path.join(vault, "pro/beta/overview/index.md"), 50);
  assert.deepEqual(entries.map((e) => e.path), ["pro/beta/overview/index.md"]);
});

test("kb_history does not follow a copy from a note with identical content", async () => {
  const a = { ...base, section: "notes", note: "twin-a" };
  const b = { ...base, section: "ideas", note: "twin-b" };
  assert.equal((await call(rw, "kb_write", { ...a, content: TEMPLATE })).isError, false);
  assert.equal((await call(rw, "kb_write", { ...b, content: TEMPLATE })).isError, false);
  const h = await call(rw, "kb_history", b);
  const lines = h.text.split("\n");
  assert.equal(lines.length, 2, h.text);
  assert.match(lines[1], /kb_write: pro\/proj\/ideas\/twin-b/);
});

test("noteHistory in a repo without commits: no history, no error", async () => {
  const { newRepo } = await import("./test-support/fixtures");
  const { noteHistory } = await import("./vault/git");
  const empty = newRepo("hist-empty");
  assert.deepEqual(await noteHistory(empty, path.join(empty, "a", "b", "c", "d.md"), 5), {
    path: "a/b/c/d.md",
    entries: [],
    restricted: false,
  });
});
