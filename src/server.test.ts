import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// DB_PATH/VAULT_PATH must be set before db.ts/server.ts are loaded (both read
// the env var at import time), so delay those imports to `before` and point
// at throwaway temp dirs instead of the real /data/acl.db and /vault.
const dbDir = mkdtempSync(join(tmpdir(), "second-brain-server-test-db-"));
process.env.DB_PATH = join(dbDir, "test.db");

const vaultRoot = mkdtempSync(join(tmpdir(), "second-brain-server-test-vault-"));
process.env.VAULT_PATH = vaultRoot;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultRoot, encoding: "utf8" });
}

let createToken: typeof import("./auth/tokens").createToken;
let db: typeof import("./db").db;
let createApp: typeof import("./server").createApp;
let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
let StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;

let server: Server;
let baseUrl: string;
let tokenA: string; // scoped read+write on proj-a/sect-a
let tokenRO: string; // read-only on proj-a/sect-a
let tokenOtherSection: string; // same project, different section
let tokenB: string; // scoped only on proj-b/sect-b (different project+section)

before(async () => {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "user.email", "test@example.com"]);

  ({ createToken } = await import("./auth/tokens"));
  ({ db } = await import("./db"));
  ({ createApp } = await import("./server"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  ));

  tokenA = createToken("token-a", [
    { project: "proj-a", section: "sect-a", permission: "write" },
    { project: "proj-a", section: "sect-a", permission: "read" },
  ]).token;

  tokenRO = createToken("token-ro", [
    { project: "proj-a", section: "sect-a", permission: "read" },
  ]).token;
  tokenOtherSection = createToken("token-other-section", [
    { project: "proj-a", section: "sect-z", permission: "read" },
    { project: "proj-a", section: "sect-z", permission: "write" },
  ]).token;

  tokenB = createToken("token-b", [
    { project: "proj-b", section: "sect-b", permission: "read" },
    { project: "proj-b", section: "sect-b", permission: "write" },
  ]).token;

  await new Promise<void>((resolve) => {
    server = createApp({ vaultRoot }).listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.equal(first.type, "text");
  return (first as { type: "text"; text: string }).text;
}

async function connectClient(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

test("kb_write then kb_read with correctly-scoped token succeeds end-to-end", async () => {
  const { client, transport } = await connectClient(tokenA);
  try {
    const writeResult = await client.callTool({
      name: "kb_write",
      arguments: {
        project: "proj-a",
        section: "sect-a",
        note: "note-1",
        content: "hello from pr4\n",
      },
    });
    assert.ok(!writeResult.isError, "write should not be a tool error");
    const commitSha = textOf(writeResult as CallToolResult);
    assert.match(commitSha, /^[0-9a-f]{40}$/);

    const headSha = git(["rev-parse", "HEAD"]).trim();
    assert.equal(commitSha, headSha);

    const log = git(["log", "--oneline", "-1"]);
    assert.match(log, /kb_write: proj-a\/sect-a\/note-1 via token-a/);

    const readResult = await client.callTool({
      name: "kb_read",
      arguments: { project: "proj-a", section: "sect-a", note: "note-1" },
    });
    assert.ok(!readResult.isError, "read should not be a tool error");
    assert.equal(textOf(readResult as CallToolResult), "hello from pr4\n");
  } finally {
    await transport.close();
  }
});

test("kb_write / kb_read with a wrongly-scoped token are denied", async () => {
  const { client, transport } = await connectClient(tokenB);
  try {
    const writeResult = await client.callTool({
      name: "kb_write",
      arguments: {
        project: "proj-a",
        section: "sect-a",
        note: "note-1",
        content: "should never be written\n",
      },
    });
    assert.equal(writeResult.isError, true);
    assert.equal(textOf(writeResult as CallToolResult), "Permission denied.");

    const readResult = await client.callTool({
      name: "kb_read",
      arguments: { project: "proj-a", section: "sect-a", note: "note-1" },
    });
    assert.equal(readResult.isError, true);
    assert.equal(textOf(readResult as CallToolResult), "Permission denied.");
  } finally {
    await transport.close();
  }
});

test("no Authorization header gets 401 before any MCP-level response", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error);
});

test("garbage Authorization header also gets 401", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer this-is-not-a-real-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
  });
  assert.equal(res.status, 401);
});

test("a malformed note name is reported distinctly from a real internal error", async () => {
  const { client, transport } = await connectClient(tokenA);
  try {
    // project/section match an ACL scope the token actually has (so this
    // exercises resolveNotePath's own validation, past the ACL check) but
    // note is not a valid slug.
    const result = await client.callTool({
      name: "kb_read",
      arguments: { project: "proj-a", section: "sect-a", note: "../evil" },
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result as CallToolResult), "Invalid project/section/note name.");

    const row = db
      .prepare("SELECT result, detail FROM audit_log WHERE action = 'kb_read' ORDER BY id DESC LIMIT 1")
      .get() as { result: string; detail: string };
    assert.equal(row.result, "error");
    assert.match(row.detail, /invalid note slug/);
  } finally {
    await transport.close();
  }
});

test("read-only token cannot write; same-project other-section token is denied", async () => {
  const ro = await connectClient(tokenRO);
  try {
    const read = await ro.client.callTool({
      name: "kb_read",
      arguments: { project: "proj-a", section: "sect-a", note: "note-1" },
    });
    assert.ok(!read.isError);
    const write = await ro.client.callTool({
      name: "kb_write",
      arguments: { project: "proj-a", section: "sect-a", note: "note-ro", content: "x" },
    });
    assert.equal(write.isError, true);
    assert.equal(textOf(write as CallToolResult), "Permission denied.");
  } finally {
    await ro.transport.close();
  }
  const other = await connectClient(tokenOtherSection);
  try {
    for (const name of ["kb_read", "kb_write"]) {
      const r = await other.client.callTool({
        name,
        arguments: { project: "proj-a", section: "sect-a", note: "note-1", content: "x" },
      });
      assert.equal(r.isError, true);
      assert.equal(textOf(r as CallToolResult), "Permission denied.");
    }
  } finally {
    await other.transport.close();
  }
  assert.throws(() => git(["cat-file", "-e", "HEAD:proj-a/sect-a/note-ro.md"]));
});

test("audit_log has the expected ok/denied rows", async () => {
  // Dedicated token: only rows from this test are counted.
  const t = createToken("audit-token", [
    { project: "proj-au", section: "sect-au", permission: "write" },
    { project: "proj-au", section: "sect-au", permission: "read" },
  ]).token;
  const a = { project: "proj-au", section: "sect-au", note: "n" };
  const { client, transport } = await connectClient(t);
  try {
    await client.callTool({ name: "kb_write", arguments: { ...a, content: "x\n" } });
    await client.callTool({ name: "kb_read", arguments: a });
    await client.callTool({ name: "kb_read", arguments: { ...a, section: "nope" } });
    await client.callTool({ name: "kb_write", arguments: { ...a, project: "nope", content: "x" } });
  } finally {
    await transport.close();
  }
  const rows = db
    .prepare("SELECT action, result, client_ip FROM audit_log WHERE token_name = 'audit-token' ORDER BY id")
    .all() as { action: string; result: string; client_ip: string | null }[];
  assert.deepEqual(
    rows.map((r) => `${r.action}:${r.result}`),
    ["kb_write:ok", "kb_read:ok", "kb_read:denied", "kb_write:denied"],
  );
  assert.ok(rows.every((r) => r.client_ip), "client ip recorded on every row");
});

test("401 writes an auth/denied audit row with a client IP", async () => {
  const before = (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'auth'").get() as { c: number }).c;
  for (const headers of [{}, { Authorization: "Bearer nope-not-a-token" }] as Record<string, string>[]) {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
    assert.equal(res.status, 401);
  }
  const rows = db
    .prepare("SELECT result, client_ip, token_id, detail FROM audit_log WHERE action = 'auth' ORDER BY id")
    .all() as { result: string; client_ip: string; token_id: string | null; detail: string }[];
  assert.equal(rows.length - before, 2);
  for (const r of rows.slice(-2)) {
    assert.equal(r.result, "denied");
    assert.match(r.client_ip, /127\.0\.0\.1/);
    assert.equal(r.token_id, null);
  }
});

test("malformed JSON gets a JSON-RPC 400 without a stack trace", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32700);
  assert.equal(body.id, null);
  assert.doesNotMatch(text, /\bat .*\(|node_modules|\.ts:/);
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("body over 1 MB gets a JSON-RPC 413 and leaves an audit row; unauthenticated is 401 first", async () => {
  const big = JSON.stringify({ pad: "x".repeat(1_100_000) });
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: big,
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
  assert.equal(body.jsonrpc, "2.0");
  assert.match(body.error.message, /Request too large \(max 1 MB\)/);
  const row = db
    .prepare("SELECT result, detail, token_name FROM audit_log WHERE action = 'http' ORDER BY id DESC LIMIT 1")
    .get() as { result: string; detail: string; token_name: string };
  assert.equal(row.result, "error");
  assert.equal(row.token_name, "token-a");
  assert.match(row.detail, /413/);

  const unauth = await fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(unauth.status, 401);
});

test("oversized content (under the body limit) is rejected and nothing is written", async () => {
  const { client, transport } = await connectClient(tokenA);
  const head = git(["rev-parse", "HEAD"]).trim();
  try {
    let isError = false;
    try {
      const r = await client.callTool({
        name: "kb_write",
        arguments: { project: "proj-a", section: "sect-a", note: "big", content: "x".repeat(600_000) },
      });
      isError = r.isError === true;
    } catch {
      isError = true;
    }
    assert.ok(isError);
    assert.equal(git(["rev-parse", "HEAD"]).trim(), head);
  } finally {
    await transport.close();
  }
});
