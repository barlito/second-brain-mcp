import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { connectClient, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let baseUrl: string;
let closeMain: () => Promise<void>;
let tok: string;
let readOnly: string;
let drain: () => Promise<void>;
let noteVersion: (b: Buffer) => string;

const abs = (rel: string): string => join(vault, rel);
const read = (rel: string): string => readFileSync(abs(rel), "utf8");
const commits = (): number => Number(git(["rev-list", "--count", "HEAD"], vault).trim());

// All text blocks of a call, plus the error flag.
async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; blocks: string[] }> {
  const { client, transport } = await connectClient(baseUrl, token);
  try {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: r.isError === true, blocks: r.content.map((c) => (c as { text: string }).text) };
  } finally {
    await transport.close();
  }
}
const at = (note: string, section = "notes") => ({ space: "sp", project: "pj", section, note });
const write = (note: string, content: string, extra: Record<string, unknown> = {}, section = "notes") =>
  call(tok, "kb_write", { ...at(note, section), content, ...extra });
const edit = (note: string, edits: unknown[], extra: Record<string, unknown> = {}, section = "notes", token = tok) =>
  call(token, "kb_edit", { ...at(note, section), edits, ...extra });
const readNote = (note: string, extra: Record<string, unknown> = {}, section = "notes") =>
  call(tok, "kb_read", { ...at(note, section), ...extra });
const versionOf = (r: { blocks: string[] }): string => r.blocks[1].replace("\nversion: ", "");
const body = (n: number): string => "x".repeat(n);

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ drainWrites: drain } = await import("./vault/git"));
  ({ noteVersion } = await import("./vault/noteVersion"));
  const { createApp } = await import("./server");
  tok = createToken("tok-wg", [
    { space: "sp", project: "pj", section: "*", permission: "read" },
    { space: "sp", project: "pj", section: "*", permission: "write" },
  ]).token;
  readOnly = createToken("tok-ro", [{ space: "sp", project: "pj", section: "*", permission: "read" }]).token;
  ({ baseUrl, close: closeMain } = await listen(createApp({ vaultRoot: vault })));
});

after(async () => {
  await drain();
  await closeMain();
  cleanup();
});

test("noteVersion equals git hash-object", () => {
  mkdirSync(abs("sp/pj/notes"), { recursive: true });
  writeFileSync(abs("sp/pj/notes/hash.md"), "héllo\n");
  const expected = git(["hash-object", "sp/pj/notes/hash.md"], vault).trim();
  assert.equal(noteVersion(readFileSync(abs("sp/pj/notes/hash.md"))), expected);
  assert.match(expected, /^[0-9a-f]{40}$/);
});

test("kb_read returns the version as a second block (full and tail)", async () => {
  await write("v", "line1\nline2\nline3\n");
  const full = await readNote("v");
  assert.equal(full.blocks.length, 2);
  assert.equal(full.blocks[0], read("sp/pj/notes/v.md"));
  assert.equal(versionOf(full), noteVersion(readFileSync(abs("sp/pj/notes/v.md"))));
  const tail = await readNote("v", { tail: 1 });
  assert.equal(tail.blocks[0], "line3\n");
  assert.equal(versionOf(tail), versionOf(full));
});

test("kb_write returns the new version and base_version guards the write", async () => {
  const w1 = await write("b", "one\n");
  assert.equal(w1.blocks.length, 2);
  assert.equal(versionOf(w1), versionOf(await readNote("b")));
  const ok = await write("b", "two\n", { base_version: versionOf(w1) });
  assert.equal(ok.isError, false, ok.blocks[0]);
  const n = commits();
  const stale = await write("b", "three\n", { base_version: versionOf(w1) });
  assert.equal(stale.isError, true);
  assert.equal(stale.blocks[0], `Conflict: the note changed since you read it (current version ${versionOf(ok)}). Re-read it, merge your changes and retry.`);
  assert.equal(commits(), n);
  assert.match(read("sp/pj/notes/b.md"), /two/);
  const missing = await write("nope", "x", { base_version: "a".repeat(40) });
  assert.equal(missing.blocks[0], "Conflict: the note no longer exists.");
  const bad = await write("b", "x", { base_version: "XYZ" });
  assert.match(bad.blocks[0], /Invalid argument `base_version`/);
});

test("kb_write shrink guard: refused, allowed, small notes and frontmatter excluded", async () => {
  await write("big", body(2000));
  const n = commits();
  const refused = await write("big", body(500));
  assert.equal(refused.isError, true);
  assert.equal(
    refused.blocks[0],
    "This write would shrink the note body from 2000 to 500 bytes. To change part of a note use kb_edit; if condensing is intended, retry with allow_shrink: true.",
  );
  assert.equal(commits(), n);
  assert.equal((await write("big", body(1500))).isError, false);
  assert.equal((await write("big", body(100), { allow_shrink: true })).isError, false);
  // Small existing body: no guard.
  await write("small", body(1000));
  assert.equal((await write("small", "y")).isError, false);
  // Frontmatter size does not count: a long frontmatter does not make a tiny body "not shrunk".
  const fm = `---\nsources: [${Array.from({ length: 15 }, (_, i) => `https://example.test/${i}-${"p".repeat(60)}`).join(", ")}]\n---\n`;
  await write("fm", fm + body(1100));
  const r = await write("fm", fm + body(100));
  assert.match(r.blocks[0], /shrink the note body from 1100 to 100 bytes/);
});

test("kb_edit applies an edit to the body, keeps the frontmatter, bumps updated", async () => {
  await write("e", "---\nsources: [https://x.test/1]\n---\nhello world\nsecond\n");
  const first = read("sp/pj/notes/e.md");
  writeFileSync(abs("sp/pj/notes/e.md"), first.replace(/updated: .*/, "updated: 2020-02-02"));
  git(["commit", "-qam", "backdate"], vault);
  const before = await readNote("e");
  const r = await edit("e", [{ old_str: "world", new_str: "there" }], { base_version: versionOf(before) });
  assert.equal(r.isError, false, r.blocks[0]);
  assert.match(r.blocks[0], /^[0-9a-f]{40}$/);
  assert.equal(versionOf(r), versionOf(await readNote("e")));
  const now = read("sp/pj/notes/e.md");
  assert.match(now, /^---\ntype: note\nsources: \[https:\/\/x\.test\/1\]\nauthor: tok-wg\ncreated: \d{4}-\d\d-\d\d\nupdated: \d{4}-\d\d-\d\d\n---\nhello there\nsecond\n$/);
  assert.ok(!now.includes("2020-02-02"));
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "kb_edit: sp/pj/notes/e via tok-wg");
});

test("kb_edit: frontmatter text is not editable, only the body", async () => {
  await write("fmt", "---\nsources: [https://x.test/1]\n---\nbody\n");
  const r = await edit("fmt", [{ old_str: "x.test", new_str: "y.test" }]);
  assert.equal(r.blocks[0], "Edit 1: old_str not found. Nothing was written.");
});

test("kb_edit errors: not found, several matches, empty old_str, nothing written", async () => {
  await write("m", "aa bb aa\ncc\n");
  const n = commits();
  assert.equal((await edit("missing-note", [{ old_str: "a", new_str: "b" }])).blocks[0], "Note not found.");
  assert.equal((await edit("m", [{ old_str: "zz", new_str: "b" }])).blocks[0], "Edit 1: old_str not found. Nothing was written.");
  assert.equal(
    (await edit("m", [{ old_str: "aa", new_str: "b" }])).blocks[0],
    "Edit 1: old_str matches 2 times; add surrounding text to make it unique. Nothing was written.",
  );
  assert.match((await edit("m", [{ old_str: "", new_str: "b" }])).blocks[0], /Invalid argument `edits`/);
  assert.equal(commits(), n);
});

test("kb_edit applies edits in order and is all or nothing", async () => {
  await write("o", "alpha\nbeta\n");
  const ok = await edit("o", [
    { old_str: "alpha", new_str: "gamma" },
    { old_str: "gamma", new_str: "delta $& $1" },
  ]);
  assert.equal(ok.isError, false, ok.blocks[0]);
  assert.match(read("sp/pj/notes/o.md"), /\ndelta \$& \$1\nbeta\n$/);
  const before = read("sp/pj/notes/o.md");
  const n = commits();
  const bad = await edit("o", [
    { old_str: "beta", new_str: "BETA" },
    { old_str: "missing", new_str: "x" },
  ]);
  assert.equal(bad.blocks[0], "Edit 2: old_str not found. Nothing was written.");
  assert.equal(read("sp/pj/notes/o.md"), before);
  assert.equal(commits(), n);
});

test("kb_edit base_version mismatch is refused", async () => {
  await write("bv", "text\n");
  const r = await edit("bv", [{ old_str: "text", new_str: "t" }], { base_version: "0".repeat(40) });
  assert.match(r.blocks[0], /^Conflict: the note changed since you read it \(current version [0-9a-f]{40}\)/);
  assert.equal((await edit("gone", [{ old_str: "a", new_str: "b" }], { base_version: "0".repeat(40) })).blocks[0], "Conflict: the note no longer exists.");
});

test("kb_edit: identical result commits nothing", async () => {
  await write("same", "keep\n");
  const n = commits();
  const r = await edit("same", [{ old_str: "keep", new_str: "keep" }]);
  assert.equal(r.isError, false);
  assert.equal(r.blocks[0], "No changes (content identical).");
  assert.equal(r.blocks[1], `\nversion: ${noteVersion(readFileSync(abs("sp/pj/notes/same.md")))}`);
  assert.equal(commits(), n);
});

test("kb_edit on a note without frontmatter (journal) edits the whole text; overview cap applies", async () => {
  await write("2026-11", "- entry one\n", {}, "journal");
  assert.equal((await edit("2026-11", [{ old_str: "one", new_str: "two" }], {}, "journal")).isError, false);
  assert.equal(read("sp/pj/journal/2026-11.md"), "- entry two\n");
  await write("index", "# small\n", {}, "overview");
  const big = await edit("index", [{ old_str: "small", new_str: "x".repeat(4000) }], {}, "overview");
  assert.equal(big.isError, true);
  assert.match(big.blocks[0], /^overview\/index is too large/);
  assert.equal(read("sp/pj/overview/index.md"), "# small\n");
});

test("kb_edit refuses archive and requires write permission", async () => {
  const arch = await edit("x", [{ old_str: "a", new_str: "b" }], {}, "archive");
  assert.match(arch.blocks[0], /Section `archive` is managed by kb_archive/);
  const denied = await edit("e", [{ old_str: "hello", new_str: "bye" }], {}, "notes", readOnly);
  assert.equal(denied.isError, true);
  assert.equal(denied.blocks[0], "Permission denied.");
});

test("kb_write and kb_edit descriptions stay well below the 4096 cut", async () => {
  const { client, transport } = await connectClient(baseUrl, tok);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ["kb_read", "kb_write", "kb_edit"]) {
      const d = tools.find((t) => t.name === name)!.description!;
      assert.ok(d.length < 2048, `${name}: ${d.length}`);
    }
  } finally {
    await transport.close();
  }
});

test("kb_edit counts overlapping matches as ambiguous", async () => {
  await write("ov", "aaa\n");
  const r = await edit("ov", [{ old_str: "aa", new_str: "b" }]);
  assert.equal(r.blocks[0], "Edit 1: old_str matches 2 times; add surrounding text to make it unique. Nothing was written.");
});

test("kb_edit refuses a result over the note size limit and oversized strings", async () => {
  await write("huge", "x\n");
  const n = commits();
  const r = await edit("huge", [{ old_str: "x", new_str: "y".repeat(512 * 1024) }]);
  assert.equal(r.isError, true);
  assert.match(r.blocks[0], /^The note would exceed the size limit/);
  assert.equal(commits(), n);
  const tooBig = await edit("huge", [{ old_str: "x", new_str: "y".repeat(512 * 1024 + 1) }]);
  assert.match(tooBig.blocks[0], /Invalid argument `edits`/);
});

test("kb_edit on a broken or section-refused frontmatter points to kb_write", async () => {
  mkdirSync(abs("sp/pj/decisions"), { recursive: true });
  writeFileSync(abs("sp/pj/decisions/wrongtype.md"), "---\ntype: guide\n---\nbody text\n");
  writeFileSync(abs("sp/pj/notes/broken.md"), "---\na: [\n---\nbody text\n");
  git(["add", "-A"], vault);
  git(["commit", "-qm", "hand-made notes"], vault);
  const n = commits();
  const wrong = await edit("wrongtype", [{ old_str: "body", new_str: "BODY" }], {}, "decisions");
  assert.match(wrong.blocks[0], /^Invalid frontmatter: .*Fix the frontmatter with kb_write\.$/);
  const broken = await edit("broken", [{ old_str: "body", new_str: "BODY" }]);
  assert.match(broken.blocks[0], /^Invalid frontmatter: .*Fix the frontmatter with kb_write\.$/);
  assert.equal(commits(), n);
});

const crlfFm = (extra: string): string => `---\r\ntype: note\r\nauthor: old\r\ncreated: 2026-01-01\r\nupdated: 2026-01-01\r\n---\r\n${extra}`;

test("kb_edit and the shrink guard handle CRLF and BOM notes", async () => {
  const long = `${"z".repeat(98)}\r\n`.repeat(20); // 2000 bytes
  for (const [name, raw] of [
    ["crlf", crlfFm(`line one\r\nline two\r\n${long}`)],
    ["bom", `﻿${crlfFm(`line one\r\nline two\r\n${long}`)}`],
  ] as const) {
    writeFileSync(abs(`sp/pj/notes/${name}.md`), raw);
    git(["add", "-A"], vault);
    git(["commit", "-qm", `hand-made ${name}`], vault);
    const r = await edit(name, [{ old_str: "line one", new_str: "line 1" }]);
    assert.equal(r.isError, false, `${name}: ${r.blocks[0]}`);
    const now = read(`sp/pj/notes/${name}.md`);
    assert.ok(now.includes("line 1\r\nline two\r\n"), name);
    assert.ok(now.includes("author: tok-wg"), name);
    const refused = await write(name, "tiny\r\n");
    assert.match(refused.blocks[0], /^This write would shrink the note body from \d{4} to 6 bytes/, name);
  }
});

test("kb_edit errors say nothing was written", async () => {
  await write("nw", "aa bb aa\n");
  const missing = await edit("nw", [{ old_str: "zz", new_str: "y" }]);
  assert.equal(missing.blocks[0], "Edit 1: old_str not found. Nothing was written.");
  const twice = await edit("nw", [{ old_str: "aa", new_str: "y" }]);
  assert.match(twice.blocks[0], /^Edit 1: old_str matches 2 times; .* Nothing was written\.$/);
});

test("kb_write hints at the Docs map when it creates an unlisted note", async () => {
  mkdirSync(abs("sp/pj/overview"), { recursive: true });
  writeFileSync(abs("sp/pj/overview/index.md"), "# pj\n\n## Docs map\n\n- `notes/listed-a`: x\n- [[notes/listed-b]]\n");
  git(["add", "-A"], vault);
  git(["commit", "-qm", "seed overview"], vault);

  const created = await write("hinted", "x\n");
  assert.equal(created.blocks.length, 3);
  assert.equal(created.blocks[2], "\nHint: add `notes/hinted` to the Docs map of overview/index.");
  const again = await write("hinted", "y\n");
  assert.equal(again.blocks.length, 2);

  assert.equal((await write("listed-a", "x\n")).blocks.length, 2);
  assert.equal((await write("listed-b", "x\n")).blocks.length, 2);
  assert.equal((await write("jr", "x\n", {}, "journal")).blocks.length, 2);
});

test("kb_write gives no Docs map hint when the token cannot read overview", async () => {
  const { createToken } = await import("./auth/tokens");
  const blind = createToken("tok-blind", [
    { space: "sp", project: "pj", section: "notes", permission: "read" },
    { space: "sp", project: "pj", section: "notes", permission: "write" },
  ]).token;
  const r = await call(blind, "kb_write", { ...at("blind-note"), content: "x\n" });
  assert.equal(r.isError, false);
  assert.equal(r.blocks.length, 2);
});
