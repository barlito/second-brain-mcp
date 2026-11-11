import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let app: Awaited<ReturnType<typeof listen>>;
let rw: string;
let ro: string;
let other: string;
const base = { space: "pro", project: "proj" };

before(async () => {
  const { createToken } = await import("./auth/tokens");
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
