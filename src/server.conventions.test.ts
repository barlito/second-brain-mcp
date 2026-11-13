import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, connectClient, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault: vaultRoot } = makeTempVault();
process.env.VAULT_PATH = vaultRoot;

let db: typeof import("./db").db;
let conv: typeof import("./tools/conventions");
let close: () => Promise<void>;
let baseUrl: string;
let tokenW: string;
let tokenRO: string;
let tokenOther: string;

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  conv = await import("./tools/conventions");
  const { createApp } = await import("./server");
  tokenW = createToken("tok-w", [
    { space: "sp", project: "pj", section: "overview", permission: "write" },
    { space: "sp", project: "pj", section: "overview", permission: "read" },
  ]).token;
  tokenRO = createToken("tok-ro", [{ space: "sp", project: "pj", section: "overview", permission: "read" }]).token;
  tokenOther = createToken("tok-other", [{ space: "sp", project: "pj", section: "notes", permission: "write" }]).token;
  ({ baseUrl, close } = await listen(createApp({ vaultRoot })));
});

after(async () => {
  await close();
  cleanup();
});

test("server instructions are exposed to clients", async () => {
  const { client, transport } = await connectClient(baseUrl, tokenW);
  try {
    assert.equal(client.getInstructions(), conv.SERVER_INSTRUCTIONS);
    assert.ok(conv.SERVER_INSTRUCTIONS.length <= 1000, `core too long: ${conv.SERVER_INSTRUCTIONS.length}`);
    assert.match(client.getInstructions()!, /overview\/index/);
    assert.ok(conv.SERVER_INSTRUCTIONS.split("\n").length <= 40);
  } finally {
    await transport.close();
  }
});

test("kb_init_project creates the entry note, then refuses a second call", async () => {
  const args = { space: "sp", project: "pj", summary: "A test project." };
  const r = await callTool(baseUrl, tokenW, "kb_init_project", args);
  assert.equal(r.isError, false);
  assert.match(r.text, /^[0-9a-f]{40}$/);
  const body = readFileSync(join(vaultRoot, "sp/pj/overview/index.md"), "utf8");
  assert.match(body, /^# pj\n\nA test project\./);
  for (const s of ["decisions", "conventions", "notes", "journal", "archive"]) {
    assert.match(body, new RegExp(`\`${s}\``));
  }
  assert.match(git(["log", "--format=%s", "-1"], vaultRoot), /^kb_init_project: sp\/pj via tok-w/);
  assert.equal(lastAudit(db, "action='kb_init_project'").result, "ok");

  const again = await callTool(baseUrl, tokenW, "kb_init_project", args);
  assert.equal(again.isError, true);
  assert.match(again.text, /already exists.*kb_write/);
  assert.equal(lastAudit(db, "action='kb_init_project'").result, "error");
});

test("kb_init_project is denied without write on overview", async () => {
  for (const t of [tokenRO, tokenOther]) {
    const r = await callTool(baseUrl, t, "kb_init_project", { space: "sp", project: "pj", summary: "x" });
    assert.equal(r.isError, true);
    assert.equal(r.text, "Permission denied.");
    assert.equal(lastAudit(db, "action='kb_init_project'").result, "denied");
  }
});

test("kb_init_project rejects a too-long or empty summary", async () => {
  const { client, transport } = await connectClient(baseUrl, tokenW);
  try {
    for (const summary of ["x".repeat(conv.SUMMARY_MAX_CHARS + 1), "  "]) {
      // The SDK reports a schema failure either as a rejection or as an isError result.
      const msg = await client
        .callTool({ name: "kb_init_project", arguments: { space: "sp", project: "pj", summary } })
        .then((r) => JSON.stringify(r))
        .catch((e: Error) => e.message);
      assert.match(msg, /summary/);
      assert.match(msg, /too long|must not be empty/);
    }
  } finally {
    await transport.close();
  }
  // Exactly at the limit passes the schema; the (out-of-scope) project is then denied by ACL.
  const ok = await callTool(baseUrl, tokenW, "kb_init_project", {
    space: "sp",
    project: "pj-max",
    summary: "x".repeat(conv.SUMMARY_MAX_CHARS),
  });
  assert.equal(ok.text, "Permission denied.");
});

test("kb_append refuses to grow overview/index past the cap", async () => {
  const a = (entry: string) =>
    callTool(baseUrl, tokenW, "kb_append", { space: "sp", project: "pj", section: "overview", note: "index", entry });
  const file = join(vaultRoot, "sp/pj/overview/index.md");
  assert.equal((await a("small entry")).isError, false);
  let refused;
  for (let i = 0; i < 20 && !refused; i++) {
    const r = await a("x".repeat(900));
    if (r.isError) refused = r;
  }
  assert.ok(refused, "append past the cap must be refused");
  assert.match(refused.text, /too large.*move detail/s);
  assert.ok(Buffer.byteLength(readFileSync(file, "utf8")) <= conv.ENTRY_NOTE_MAX_BYTES);
});

test("every tool named in the instructions is registered", async () => {
  const { client, transport } = await connectClient(baseUrl, tokenW);
  try {
    const registered = new Set((await client.listTools()).tools.map((t) => t.name));
    const mentioned = new Set(conv.SERVER_INSTRUCTIONS.match(/\bkb_[a-z_]+/g));
    assert.ok(mentioned.size >= 3);
    for (const name of mentioned) assert.ok(registered.has(name), `${name} not registered`);
    const tools = (await client.listTools()).tools;
    const kbWrite = tools.find((t) => t.name === "kb_write")!.description!;
    for (const r of conv.RESERVED_SECTIONS) assert.ok(kbWrite.includes(`${r.section} (`));
  } finally {
    await transport.close();
  }
});

test("kb_write caps overview/index at the byte limit", async () => {
  const w = (content: string, note = "index") =>
    callTool(baseUrl, tokenW, "kb_write", { space: "sp", project: "pj", section: "overview", note, content });
  const max = conv.ENTRY_NOTE_MAX_BYTES;
  assert.equal((await w("a".repeat(max))).isError, false);
  const over = await w("a".repeat(max + 1));
  assert.equal(over.isError, true);
  assert.match(over.text, /too large.*move detail/s);
  assert.match(lastAudit(db, "action='kb_write'").detail ?? "", /too large/);
  // Multi-byte: characters under the limit, bytes over it.
  assert.equal((await w("é".repeat(max / 2 + 1))).isError, true);
  assert.equal((await w("é".repeat(max / 2))).isError, false);
  // Other overview notes are not capped.
  assert.equal((await w("a".repeat(max * 2), "details")).isError, false);
});
