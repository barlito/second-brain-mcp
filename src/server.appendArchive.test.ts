import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
let rw: string;
let ro: string;
let onlyJournal: string;
const base = { space: "pro", project: "proj" };

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");
  rw = createToken("agent-rw", [{ space: "pro", project: "*", section: "*", permission: "write" }]).token;
  ro = createToken("agent-ro", [{ space: "pro", project: "*", section: "*", permission: "read" }]).token;
  onlyJournal = createToken("agent-j", [{ space: "pro", project: "proj", section: "journal", permission: "write" }]).token;
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const call = (tok: string, name: string, args: Record<string, unknown>) => callTool(app.baseUrl, tok, name, args);

test("kb_append formats a line, creates the note, collapses newlines, audits", async () => {
  const args = { ...base, section: "journal", note: "2026-11" };
  const r = await call(rw, "kb_append", { ...args, entry: "did a thing\nbecause\r\nreasons" });
  assert.equal(r.isError, false);
  assert.match(r.text, /^[0-9a-f]{40}$/);
  await call(rw, "kb_append", { ...args, entry: "second" });
  const lines = readFileSync(join(vault, "pro/proj/journal/2026-11.md"), "utf8").split("\n");
  assert.match(lines[0], /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \[agent-rw\] did a thing because reasons$/);
  assert.match(lines[1], /\[agent-rw\] second$/);
  assert.equal(lines[2], "");
  assert.match(git(["log", "-1", "--format=%s"], vault), /^kb_append: pro\/proj\/journal\/2026-11 via agent-rw/);
  assert.equal(lastAudit(db, "token_name = 'agent-rw'").action, "kb_append");
});

test("kb_append rejects empty/too long entries and enforces write scope", async () => {
  const args = { ...base, section: "journal", note: "2026-11" };
  assert.equal((await call(rw, "kb_append", { ...args, entry: "" })).isError, true);
  assert.equal((await call(rw, "kb_append", { ...args, entry: "x".repeat(1001) })).isError, true);
  const blank = await call(rw, "kb_append", { ...args, entry: " \n " });
  assert.deepEqual(blank, { isError: true, text: "Entry is empty." });
  assert.deepEqual(await call(ro, "kb_append", { ...args, entry: "x" }), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(onlyJournal, "kb_append", { ...base, section: "notes", note: "n", entry: "x" }), {
    isError: true,
    text: "Permission denied.",
  });
  assert.equal((await call(onlyJournal, "kb_append", { ...args, entry: "ok" })).isError, false);
});

test("kb_read tail returns the last N lines", async () => {
  const args = { ...base, section: "journal", note: "2026-11" };
  const all = (await call(ro, "kb_read", args)).text.split("\n").filter(Boolean);
  const t = await call(ro, "kb_read", { ...args, tail: 1 });
  assert.equal(t.text, all[all.length - 1] + "\n");
  assert.equal((await call(ro, "kb_read", { ...args, tail: 500 })).text, all.join("\n") + "\n");
  assert.equal((await call(ro, "kb_read", { ...args, tail: 0 })).isError, true);
  assert.equal((await call(ro, "kb_read", { ...args, tail: 501 })).isError, true);
});

test("kb_archive moves to archive/<section>-<note>, then -2, and keeps history", async () => {
  const w = { ...base, section: "notes", note: "idea" };
  await call(rw, "kb_write", { ...w, content: "one\n" });
  const r1 = await call(rw, "kb_archive", w);
  assert.deepEqual(r1, { isError: false, text: "pro/proj/archive/notes-idea" });
  assert.equal(existsSync(join(vault, "pro/proj/notes/idea.md")), false);
  assert.equal(readFileSync(join(vault, "pro/proj/archive/notes-idea.md"), "utf8"), "one\n");
  assert.equal(lastAudit(db, "token_name = 'agent-rw'").action, "kb_archive");

  await call(rw, "kb_write", { ...w, content: "two\n" });
  assert.equal((await call(rw, "kb_archive", w)).text, "pro/proj/archive/notes-idea-2");
  await call(rw, "kb_write", { ...w, content: "three\n" });
  assert.equal((await call(rw, "kb_archive", w)).text, "pro/proj/archive/notes-idea-3");
});

test("kb_archive truncates long names to a valid slug and avoids collisions", async () => {
  const note = "n".repeat(64);
  const w = { ...base, section: "notes", note };
  await call(rw, "kb_write", { ...w, content: "a" });
  const r1 = await call(rw, "kb_archive", w);
  assert.equal(r1.text, `pro/proj/archive/${("notes-" + note).slice(0, 64)}`);
  await call(rw, "kb_write", { ...w, content: "b" });
  const r2 = await call(rw, "kb_archive", w);
  assert.equal(r2.text.split("/")[3].length, 64);
  assert.match(r2.text, /-2$/);
  assert.notEqual(r1.text, r2.text);
});

test("kb_archive refusals: missing, already archived, entry note, scope", async () => {
  assert.deepEqual(await call(rw, "kb_archive", { ...base, section: "notes", note: "ghost" }), {
    isError: true,
    text: "Note not found.",
  });
  assert.equal((await call(rw, "kb_archive", { ...base, section: "archive", note: "notes-idea" })).isError, true);
  await call(rw, "kb_write", { ...base, section: "overview", note: "index", content: "entry" });
  const e = await call(rw, "kb_archive", { ...base, section: "overview", note: "index" });
  assert.equal(e.isError, true);
  assert.match(e.text, /cannot be archived/);
  assert.ok(existsSync(join(vault, "pro/proj/overview/index.md")));
  await call(rw, "kb_write", { ...base, section: "notes", note: "keep", content: "k" });
  assert.deepEqual(await call(ro, "kb_archive", { ...base, section: "notes", note: "keep" }), {
    isError: true,
    text: "Permission denied.",
  });
  assert.deepEqual(await call(onlyJournal, "kb_archive", { ...base, section: "notes", note: "keep" }), {
    isError: true,
    text: "Permission denied.",
  });
});
