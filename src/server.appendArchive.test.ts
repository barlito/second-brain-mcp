import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

const MAX = 512 * 1024; // MAX_CONTENT_CHARS
makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
let rw: string;
let ro: string;
let onlyJournal: string;
let notesOnly: string;
let notesAndArchive: string;
let archiveReader: string;
let blindArchiver: string;
const base = { space: "pro", project: "proj" };

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");
  rw = createToken("agent-rw", [
    { space: "pro", project: "*", section: "*", permission: "write" },
    { space: "pro", project: "*", section: "*", permission: "read" },
  ]).token;
  ro = createToken("agent-ro", [{ space: "pro", project: "*", section: "*", permission: "read" }]).token;
  onlyJournal = createToken("agent-j", [{ space: "pro", project: "proj", section: "journal", permission: "write" }]).token;
  const sc = (section: string, permission: "read" | "write") => ({ space: "pro", project: "proj", section, permission });
  notesOnly = createToken("agent-notes", [sc("notes", "write")]).token;
  notesAndArchive = createToken("agent-na", [sc("notes", "read"), sc("notes", "write"), sc("archive", "write")]).token;
  // Can write (but not read) notes, and can read the archive: must not be able to launder a note through it.
  blindArchiver = createToken("agent-blind", [sc("notes", "write"), sc("archive", "write"), sc("archive", "read")]).token;
  archiveReader = createToken("agent-ar", [sc("archive", "read")]).token;
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

test("kb_read refuses a note over the read cap with a clear message", async () => {
  const { MAX_READ_BYTES } = await import("./tools/kbRead");
  const args = { ...base, section: "notes", note: "huge" };
  mkdirSync(join(vault, "pro/proj/notes"), { recursive: true });
  writeFileSync(join(vault, "pro/proj/notes/huge.md"), "x".repeat(MAX_READ_BYTES + 1));
  try {
    assert.deepEqual(await call(ro, "kb_read", args), {
      isError: true,
      text: `Note is too large to read (${MAX_READ_BYTES + 1} bytes, max ${MAX_READ_BYTES}).`,
    });
    const row = lastAudit(db, "token_name = 'agent-ro'");
    assert.equal(row.result, "error");
    assert.match(row.detail ?? "", /note too large/);
    writeFileSync(join(vault, "pro/proj/notes/huge.md"), "x".repeat(MAX_READ_BYTES));
    assert.equal((await call(ro, "kb_read", args)).text.length, MAX_READ_BYTES);
  } finally {
    rmSync(join(vault, "pro/proj/notes/huge.md"));
  }
  assert.deepEqual(await call(ro, "kb_read", args), { isError: true, text: "Note not found." });
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

test("kb_archive needs read on the source: write + read-on-archive cannot launder an unreadable note", async () => {
  const w = { ...base, section: "notes", note: "blind" };
  await call(rw, "kb_write", { ...w, content: "secret\n" });
  assert.deepEqual(await call(blindArchiver, "kb_read", w), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(blindArchiver, "kb_archive", w), { isError: true, text: "Permission denied." });
  const row = lastAudit(db, "token_name = 'agent-blind'");
  assert.equal(row.action, "kb_archive");
  assert.equal(row.result, "denied");
  assert.equal(row.detail, "no read on source section");
  assert.ok(existsSync(join(vault, "pro/proj/notes/blind.md")));
  assert.equal(existsSync(join(vault, "pro/proj/archive/notes-blind.md")), false);
});

test("kb_archive needs write on source AND archive; reading archive needs read on archive", async () => {
  const w = { ...base, section: "notes", note: "acl" };
  await call(rw, "kb_write", { ...w, content: "secret\n" });
  assert.deepEqual(await call(notesOnly, "kb_archive", w), { isError: true, text: "Permission denied." });
  const denied = lastAudit(db, "token_name = 'agent-notes'");
  assert.equal(denied.action, "kb_archive");
  assert.equal(denied.result, "denied");
  assert.ok(existsSync(join(vault, "pro/proj/notes/acl.md")));
  const ok = await call(notesAndArchive, "kb_archive", w);
  assert.deepEqual(ok, { isError: false, text: "pro/proj/archive/notes-acl" });
  const row = lastAudit(db, "token_name = 'agent-na'");
  assert.equal(row.result, "ok");
  assert.equal(row.detail, "-> archive/notes-acl");
  const a = { ...base, section: "archive", note: "notes-acl" };
  assert.deepEqual(await call(notesOnly, "kb_read", a), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(archiveReader, "kb_read", a), { isError: false, text: "secret\n" });
});

test("archive section is writable only through kb_archive", async () => {
  const a = { ...base, section: "archive", note: "direct" };
  for (const [tool, extra] of [
    ["kb_write", { content: "x" }],
    ["kb_append", { entry: "x" }],
  ] as const) {
    const r = await call(rw, tool, { ...a, ...extra });
    assert.equal(r.isError, true);
    assert.match(r.text, /managed by kb_archive/);
    assert.equal(lastAudit(db, "token_name = 'agent-rw'").detail, "reserved section");
  }
  assert.equal(existsSync(join(vault, "pro/proj/archive/direct.md")), false);
});

test("kb_archive refuses a note with uncommitted changes", async () => {
  const w = { ...base, section: "notes", note: "dirty" };
  await call(rw, "kb_write", { ...w, content: "committed\n" });
  writeFileSync(join(vault, "pro/proj/notes/dirty.md"), "human edit\n");
  const r = await call(rw, "kb_archive", w);
  assert.deepEqual(r, { isError: true, text: "Note has uncommitted changes in the vault; commit or discard them first." });
  assert.equal(readFileSync(join(vault, "pro/proj/notes/dirty.md"), "utf8"), "human edit\n");
  git(["checkout", "--", "pro/proj/notes/dirty.md"], vault);
  assert.equal((await call(rw, "kb_archive", w)).isError, false);
});

test("kb_append collapses every line terminator incl. U+2028/U+0085", async () => {
  const args = { ...base, section: "journal", note: "2026-12" };
  await call(rw, "kb_append", { ...args, entry: "a\u2028b\u2029c\u0085d\u000be\u000cf\rg\nh" });
  const lines = readFileSync(join(vault, "pro/proj/journal/2026-12.md"), "utf8").split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[agent-rw\] a b c d e f g h$/);
});

test("kb_append enforces the note size limit at the boundary", async () => {
  const args = { ...base, section: "journal", note: "big" };
  await call(rw, "kb_append", { ...args, entry: "probe" });
  const lineLen = readFileSync(join(vault, "pro/proj/journal/big.md"), "utf8").length;
  const filler = "a".repeat(MAX - lineLen - 1) + "\n";
  await call(rw, "kb_write", { ...args, content: filler });
  assert.equal((await call(rw, "kb_append", { ...args, entry: "probe" })).isError, false);
  assert.equal(readFileSync(join(vault, "pro/proj/journal/big.md"), "utf8").length, MAX);
  const r = await call(rw, "kb_append", { ...args, entry: "probe" });
  assert.equal(r.isError, true);
  assert.match(r.text, /journal\/YYYY-MM/);
  assert.equal(readFileSync(join(vault, "pro/proj/journal/big.md"), "utf8").length, MAX);
  assert.equal(git(["status", "--porcelain"], vault), "");
});

test("kb_append refuses a note that is not valid UTF-8 and leaves its bytes alone", async () => {
  const args = { ...base, section: "journal", note: "latin1" };
  const rel = "pro/proj/journal/latin1.md";
  const bytes = Buffer.from("caf\xe9\n", "latin1");
  writeFileSync(join(vault, rel), bytes);
  git(["add", rel], vault);
  git(["commit", "-m", "latin1 seed"], vault);
  const r = await call(rw, "kb_append", { ...args, entry: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.text, "Note is not valid UTF-8; edit it in git.");
  assert.ok(readFileSync(join(vault, rel)).equals(bytes));
  assert.equal(lastAudit(db, "token_name = 'agent-rw'").detail, "note not utf-8");
});

test("kb_write with identical content reports no change, never someone else's commit", async () => {
  const args = { ...base, section: "notes", note: "same" };
  const first = await call(rw, "kb_write", { ...args, content: "same\n" });
  assert.match(first.text, /^[0-9a-f]{40}$/);
  // Someone else commits after us: HEAD is now their commit.
  writeFileSync(join(vault, "unrelated.md"), "u\n");
  git(["add", "unrelated.md"], vault);
  git(["commit", "-m", "human"], vault);
  const head = git(["rev-parse", "HEAD"], vault).trim();
  const again = await call(rw, "kb_write", { ...args, content: "same\n" });
  assert.equal(again.isError, false);
  assert.equal(again.text, "No changes (content identical).");
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);
  const row = lastAudit(db, "token_name = 'agent-rw'") as ReturnType<typeof lastAudit> & { git_commit: string | null };
  assert.equal(row.action, "kb_write");
  assert.equal(row.git_commit, null);
  assert.equal(row.detail, "no changes (content identical)");
});

test("kb_append: concurrent entries land in non-decreasing timestamp order", async () => {
  const args = { ...base, section: "journal", note: "order" };
  await Promise.all(Array.from({ length: 12 }, (_, i) => call(rw, "kb_append", { ...args, entry: `e${i}` })));
  const stamps = readFileSync(join(vault, "pro/proj/journal/order.md"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(2, 18));
  assert.equal(stamps.length, 12);
  assert.deepEqual(stamps, [...stamps].sort());
});
