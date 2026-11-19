import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
let noArchive: string;
let noDest: string;
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
  const sc = (section: string) => ({ space: "pro", project: "proj", section, permission: "write" as const });
  noArchive = createToken("agent-noarch", [sc("notes")]).token;
  noDest = createToken("agent-nodest", [sc("archive")]).token;
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const call = (tok: string, name: string, args: Record<string, unknown>) => callTool(app.baseUrl, tok, name, args);
const sha = (n: number): string => git(["log", "--format=%H", "--", "pro/proj/notes/rev.md"], vault).trim().split("\n")[n];
const target = { ...base, section: "notes", note: "rev" };

test("kb_read rev: content at a commit (full and short sha), tail, errors, ACL", async () => {
  await call(rw, "kb_write", { ...base, section: "notes", note: "pre", content: "pre\n" });
  const first = git(["rev-parse", "HEAD"], vault).trim(); // predates the note
  await call(rw, "kb_write", { ...target, content: "one\nuno\n" });
  await call(rw, "kb_write", { ...target, content: "two\ndos\n" });
  const oldest = sha(1);
  const full = await call(ro, "kb_read", { ...target, rev: oldest });
  assert.equal(full.isError, false);
  assert.match(full.text, /one\nuno\n$/);
  assert.equal((await call(ro, "kb_read", { ...target, rev: oldest.slice(0, 7) })).text, full.text);
  assert.match((await call(ro, "kb_read", target)).text, /two\ndos\n$/);
  const t = await call(ro, "kb_read", { ...target, rev: oldest, tail: 1 });
  assert.equal(t.text, "uno\n");

  assert.deepEqual(await call(ro, "kb_read", { ...target, rev: "0".repeat(40) }), { isError: true, text: "Unknown revision." });
  assert.deepEqual(await call(ro, "kb_read", { ...target, rev: "deadbee" }), { isError: true, text: "Unknown revision." });
  for (const bad of ["--help", "HEAD", "ABCDEF1", "abc", "a".repeat(41), "-p", "abcdef0:x"]) {
    const r = await call(ro, "kb_read", { ...target, rev: bad });
    assert.equal(r.isError, true, bad);
    assert.match(r.text, /Invalid argument `rev`/, bad);
  }
  // a commit that exists but predates the note
  assert.deepEqual(await call(ro, "kb_read", { ...target, rev: first }), { isError: true, text: "Note not found at this revision." });
  // ACL: no read on the section
  const { createToken } = await import("./auth/tokens");
  const other = createToken("agent-j", [{ space: "pro", project: "proj", section: "journal", permission: "read" }]).token;
  assert.deepEqual(await call(other, "kb_read", { ...target, rev: oldest }), { isError: true, text: "Permission denied." });
  assert.equal(lastAudit(db, "token_name = 'agent-ro' AND action = 'kb_read'").result, "error");
});

test("kb_read rev refuses an oversized blob", async () => {
  writeFileSync(join(vault, "pro/proj/notes/huge.md"), "x".repeat(2 * 1024 * 1024 + 1));
  git(["add", "."], vault);
  git(["commit", "-m", "huge"], vault);
  const r = await call(ro, "kb_read", { ...base, section: "notes", note: "huge", rev: git(["rev-parse", "HEAD"], vault).trim() });
  assert.equal(r.isError, true);
  assert.match(r.text, /too large to read/);
});

test("kb_unarchive: moves back, one commit, audited; refusals", async () => {
  await call(rw, "kb_write", { ...base, section: "notes", note: "old-idea", content: "idea\n" });
  const arch = await call(rw, "kb_archive", { ...base, section: "notes", note: "old-idea" });
  assert.equal(arch.text, "pro/proj/archive/notes-old-idea");
  const args = { ...base, archived: "notes-old-idea", section: "decisions", note: "back" };

  assert.deepEqual(await call(noArchive, "kb_unarchive", args), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(noDest, "kb_unarchive", args), { isError: true, text: "Permission denied." });
  assert.deepEqual(await call(ro, "kb_unarchive", args), { isError: true, text: "Permission denied." });
  assert.equal((await call(rw, "kb_unarchive", { ...args, section: "archive" })).isError, true);
  assert.equal((await call(rw, "kb_unarchive", { ...args, section: "Bad" })).text, "Invalid space/project/section/note name.");
  assert.deepEqual(await call(rw, "kb_unarchive", { ...args, archived: "nope" }), { isError: true, text: "Note not found." });

  const r = await call(rw, "kb_unarchive", args);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, "pro/proj/decisions/back");
  assert.equal(existsSync(join(vault, "pro/proj/archive/notes-old-idea.md")), false);
  assert.match(readFileSync(join(vault, "pro/proj/decisions/back.md"), "utf8"), /idea/);
  assert.match(git(["log", "-1", "--format=%s"], vault), /^kb_unarchive: pro\/proj\/archive\/notes-old-idea -> decisions\/back via agent-rw/);
  const a = lastAudit(db, "action = 'kb_unarchive' AND result = 'ok'");
  assert.equal(a.git_commit, git(["rev-parse", "HEAD"], vault).trim());
});

test("kb_unarchive: destination exists, entry note cap, uncommitted changes", async () => {
  await call(rw, "kb_write", { ...base, section: "notes", note: "a", content: "a\n" });
  await call(rw, "kb_write", { ...base, section: "notes", note: "b", content: "b\n" });
  await call(rw, "kb_archive", { ...base, section: "notes", note: "a" });
  const taken = await call(rw, "kb_unarchive", { ...base, archived: "notes-a", section: "notes", note: "b" });
  assert.deepEqual(taken, { isError: true, text: "A note already exists at the destination." });

  writeFileSync(join(vault, "pro/proj/archive/notes-a.md"), "x".repeat(4000));
  git(["add", "."], vault);
  git(["commit", "-m", "grow"], vault);
  const big = await call(rw, "kb_unarchive", { ...base, archived: "notes-a", section: "overview", note: "index" });
  assert.equal(big.isError, true);
  assert.match(big.text, /overview\/index is too large/);
  assert.equal(existsSync(join(vault, "pro/proj/archive/notes-a.md")), true);

  writeFileSync(join(vault, "pro/proj/archive/notes-a.md"), "dirty\n");
  const dirty = await call(rw, "kb_unarchive", { ...base, archived: "notes-a", section: "notes", note: "a2" });
  assert.match(dirty.text, /uncommitted changes/);
});
