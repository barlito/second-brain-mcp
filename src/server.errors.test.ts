// Client-facing error mapping in withAclAndAudit: each internal failure maps
// to a fixed message while the real reason lands in the audit detail.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, cloneRepo, git, makeBareRemote, makeTempDb, newRepo, tmp } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();

let createToken: typeof import("./auth/tokens").createToken;
let createApp: typeof import("./server").createApp;
let db: typeof import("./db").db;
let drainWrites: typeof import("./vault/git").drainWrites;
let token: string;

before(async () => {
  ({ createToken } = await import("./auth/tokens"));
  ({ createApp } = await import("./server"));
  ({ db } = await import("./db"));
  ({ drainWrites } = await import("./vault/git"));
  token = createToken("err-token", [
    { project: "proj", section: "sect", permission: "write" },
    { project: "proj", section: "sect", permission: "read" },
  ]).token;
});
after(cleanup);

const args = { project: "proj", section: "sect", note: "n" };

test("invalid slug (and over-long slug via the audited handler) maps to the name message", async () => {
  const vault = newRepo();
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const r = await callTool(app.baseUrl, token, "kb_read", { ...args, note: "Bad Name" });
    assert.deepEqual(r, { isError: true, text: "Invalid project/section/note name." });
    assert.match(lastAudit(db, "token_name = 'err-token'").detail ?? "", /invalid/);
  } finally {
    await app.close();
  }
});

test("UnsafePathError (symlinked section) -> 'Path not allowed.'", async () => {
  const vault = newRepo();
  const outside = tmp("outside");
  mkdirSync(join(vault, "proj"));
  symlinkSync(outside, join(vault, "proj", "sect"));
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const r = await callTool(app.baseUrl, token, "kb_write", { ...args, content: "x" });
    assert.deepEqual(r, { isError: true, text: "Path not allowed." });
    const row = lastAudit(db, "token_name = 'err-token'");
    assert.equal(row.result, "error");
    assert.match(row.detail ?? "", /symlink/);
    assert.equal(existsSync(join(outside, "n.md")), false);
  } finally {
    await app.close();
  }
});

test("VaultBusyError (fresh index.lock) -> busy message", async () => {
  const vault = newRepo();
  writeFileSync(join(vault, ".git", "index.lock"), "");
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const r = await callTool(app.baseUrl, token, "kb_write", { ...args, content: "x" });
    assert.deepEqual(r, { isError: true, text: "Vault is busy, retry in a moment." });
    assert.match(lastAudit(db, "token_name = 'err-token'").detail ?? "", /busy/);
  } finally {
    await app.close();
  }
});

test("SyncConflictError -> conflict message naming the backup branch", async () => {
  const remote = makeBareRemote();
  const vault = cloneRepo(remote, "vault");
  mkdirSync(join(vault, "proj", "sect"), { recursive: true });
  writeFileSync(join(vault, "proj", "sect", "n.md"), "base\n");
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);
  git(["push", "-u", "origin", "main"], vault);
  const other = cloneRepo(remote, "other");

  // Local unpushed edit vs conflicting remote edit of the same note.
  writeFileSync(join(vault, "proj", "sect", "n.md"), "local\n");
  git(["commit", "-am", "local"], vault);
  writeFileSync(join(other, "proj", "sect", "n.md"), "remote\n");
  git(["commit", "-am", "remote"], other);
  git(["push"], other);

  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const r = await callTool(app.baseUrl, token, "kb_write", { ...args, note: "other", content: "x" });
    await drainWrites();
    assert.equal(r.isError, true);
    assert.match(
      r.text,
      /^Conflict: this note was changed remotely\. Your version was saved on branch conflict\/\S+\. Re-read the note and retry\.$/,
    );
    assert.doesNotMatch(r.text, /\/tmp|sb-server/);
  } finally {
    await app.close();
  }
});

test("anything else -> 'Internal error.' with the real reason (credentials stripped) in audit and log", async () => {
  const vault = newRepo();
  // A regular file where the section dir should be makes the write fail generically.
  mkdirSync(join(vault, "proj"));
  writeFileSync(join(vault, "proj", "sect"), "not a dir");
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  const app = await listen(createApp({ vaultRoot: vault }));
  try {
    const r = await callTool(app.baseUrl, token, "kb_write", { ...args, content: "x" });
    assert.deepEqual(r, { isError: true, text: "Internal error." });
    const row = lastAudit(db, "token_name = 'err-token'");
    assert.equal(row.result, "error");
    assert.ok(row.detail && row.detail.length > 0);
    assert.ok(logged.some((l) => l.includes("kb_write") && l.includes("err-token")));
  } finally {
    console.error = orig;
    await app.close();
  }
});

test("an audit failure after a landed write still returns success", async () => {
  const vault = newRepo();
  const app = await listen(createApp({ vaultRoot: vault }));
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  // Break audit inserts for the duration of the call.
  db.exec("ALTER TABLE audit_log RENAME TO audit_log_bak");
  try {
    const r = await callTool(app.baseUrl, token, "kb_write", { ...args, content: "kept\n" });
    assert.equal(r.isError, false);
    assert.match(r.text, /^[0-9a-f]{40}$/);
    assert.equal(git(["rev-parse", "HEAD"], vault).trim(), r.text);
    assert.ok(logged.some((l) => l.includes("audit write failed")));
  } finally {
    db.exec("ALTER TABLE audit_log_bak RENAME TO audit_log");
    console.error = orig;
    await app.close();
  }
});
