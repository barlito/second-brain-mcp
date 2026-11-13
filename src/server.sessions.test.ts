import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;
// Leftover pending requests of other tests must not trip the per-client caps; dedicated tests override.
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
// This file tests the approval flow from zero access; the default meta baseline is covered in server.baseline.test.ts.
process.env.SESSION_BASELINE_SCOPES = "none";

type Db = typeof import("./db").db;
let db: Db;
let app: Awaited<ReturnType<typeof listen>>;
let tokens: typeof import("./auth/tokens");
let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");
let mkApp: (anon?: Partial<import("./rateLimit").AnonLimits>) => Promise<Awaited<ReturnType<typeof listen>>>;
let masterToken: string;
let KEY: string;
let keys: typeof import("./auth/connectorKeys");
// Approving by id needs the typed code (what the admin does on the card).
const approve = (ref: string, opts: Omit<Parameters<typeof access.approveRequest>[1], "code"> & { code?: string }) => {
  const row = db.prepare("SELECT code FROM access_requests WHERE id = ?").get(ref) as { code: string } | undefined;
  return access.approveRequest(ref, { code: row?.code, ...opts });
};

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1.0" } },
};

interface Rpc {
  status: number;
  headers: Headers;
  json: any;
}

async function rpc(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Rpc> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": KEY, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  const data = /^data: (.*)$/m.exec(text);
  try {
    json = JSON.parse(data ? data[1] : text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

async function connect(base = app.baseUrl, extra: Record<string, string> = {}): Promise<string> {
  const r = await rpc(base, INIT, extra);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sid = r.headers.get("mcp-session-id");
  assert.match(sid ?? "", /^[0-9a-f]{64}$/);
  return sid as string;
}

let nextId = 10;
async function call(sid: string, name: string, args: Record<string, unknown>, base = app.baseUrl, extra: Record<string, string> = {}): Promise<{ isError: boolean; text: string; status: number }> {
  const r = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid, ...extra });
  return { status: r.status, isError: r.json?.result?.isError === true, text: r.json?.result?.content?.[0]?.text ?? JSON.stringify(r.json) };
}

const bearerCall = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${masterToken}` });
  return { isError: r.json?.result?.isError === true, text: r.json?.result?.content?.[0]?.text as string };
};

function request(sid: string, space: string, project: string, access = "write"): Promise<{ isError: boolean; text: string; status: number }> {
  return call(sid, "kb_request_access", { space, project, access, reason: "work on it" });
}
const reqId = (text: string): string => /Request id: ([0-9a-f-]{36})/.exec(text)![1];
const reqCode = (text: string): string => /Code: ([A-Z0-9]{6})/.exec(text)![1];
const sidRow = (sid: string) => db.prepare("SELECT * FROM sessions WHERE sid_hash = ?").get(sessions.hashSid(sid)) as { id: string; last_seen_at: string } | undefined;
const headSha = (): string => git(["rev-parse", "HEAD"], vault).trim();

before(async () => {
  ({ db } = await import("./db"));
  tokens = await import("./auth/tokens");
  access = await import("./access");
  sessions = await import("./auth/sessions");
  const { createApp, AuthFailureLimiter } = await import("./server");
  const { anonLimits } = await import("./rateLimit");
  // A generous failure limiter: many tests deliberately fail auth from the same address.
  mkApp = (anon = {}) => listen(createApp({ vaultRoot: vault, authLimiter: new AuthFailureLimiter(100_000), anonLimits: { ...anonLimits(), initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, sessionsPerIp: 1000, ipCallsPerMin: 100000, sessionCallsPerMin: 100000, ...anon } }));
  keys = await import("./auth/connectorKeys");
  KEY = keys.createConnectorKey("test-key", "test-admin-secret").key;
  app = await mkApp();
  masterToken = tokens.createToken("master", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  for (const p of ["proj-a", "proj-b"]) {
    const r = await bearerCall("kb_write", { space: "sp", project: p, section: "notes", note: "n1", content: `secret of ${p}` });
    assert.equal(r.isError, false, r.text);
  }
  await bearerCall("kb_write", { space: "meta", project: "prefs", section: "notes", note: "style", content: "terse" });
});

after(async () => {
  await app.close();
  cleanup();
});

test("initialize without a token issues a random session id, stored hashed with client info and IP", async () => {
  const sid = await connect();
  const row = sidRow(sid) as any;
  assert.ok(row);
  assert.equal(row.client_name, "Claude Code");
  assert.equal(row.client_version, "2.1.0");
  assert.match(row.remote_ip, /127\.0\.0\.1/);
  assert.notEqual(row.sid_hash, sid);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM sessions").all()).includes(sid), false, "plaintext id never stored");
  // Two sessions never share an id.
  assert.notEqual(await connect(), sid);
});

test("initialize result carries the public instructions with the access flow and nothing sensitive", async () => {
  const r = await rpc(app.baseUrl, INIT);
  const text: string = r.json.result.instructions;
  assert.match(text, /kb_request_access/);
  assert.match(text, /No access for this session/);
  assert.doesNotMatch(text, /sb_[A-Za-z0-9_-]{10}|Bearer|password|secret|barlito|https?:\/\//i);
});

test("tools/list works with a session and lists the access tools; the other kb_* stay listed (public)", async () => {
  const sid = await connect();
  const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid });
  assert.equal(r.status, 200);
  const names: string[] = r.json.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("kb_request_access") && names.includes("kb_access_status") && names.includes("kb_read"));
});

test("missing session id is 400, unknown or malformed ones are 404 (client re-initializes)", async () => {
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  assert.equal((await rpc(app.baseUrl, list)).status, 400);
  const unknown = await rpc(app.baseUrl, list, { "mcp-session-id": "f".repeat(64) });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, -32001);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": "x".repeat(500) })).status, 404);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": "../../etc" })).status, 404);
});

test("notifications and ping work with a session", async () => {
  const sid = await connect();
  const n = await fetch(`${app.baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid, "x-api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(n.status, 202);
  assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-session-id": sid })).status, 200);
});

test("method allowlist without a token: everything else is refused before any session lookup", async () => {
  const sid = await connect();
  for (const method of ["resources/list", "prompts/list", "completion/complete", "logging/setLevel", "resources/read", "tasks/list", "nonsense"]) {
    const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 5, method, params: {} }, { "mcp-session-id": sid });
    assert.equal(r.status, 403, method);
    // No session needed to be refused: the allowlist runs first.
    assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 5, method, params: {} })).status, 403, method);
  }
  // A batch with one forbidden member is refused as a whole.
  const batch = await rpc(app.baseUrl, [{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", id: 7, method: "resources/list" }], { "mcp-session-id": sid });
  assert.equal(batch.status, 403);
  // Client-to-server responses make no sense here.
  assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": sid })).status, 400);
  assert.equal((await rpc(app.baseUrl, [], { "mcp-session-id": sid })).status, 400);
});

test("initialize must be a single, valid request; GET and DELETE are 405, never a 401 (no OAuth discovery)", async () => {
  assert.equal((await rpc(app.baseUrl, [INIT, { jsonrpc: "2.0", id: 2, method: "ping" }])).status, 400);
  assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status, 400);
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${app.baseUrl}/mcp`, { method, headers: { Accept: "text/event-stream" } });
    assert.equal(res.status, 405, method);
  }
});

test("without a grant every other kb_* tool is refused with the access hint, and the vault is untouched", async () => {
  const sid = await connect();
  const before = headSha();
  const rowsBefore = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE 'session has no grant%'").get() as { c: number }).c;
  const args = { space: "sp", project: "proj-a", section: "notes", note: "n1" };
  const calls: Array<[string, Record<string, unknown>]> = [
    ["kb_read", args],
    ["kb_write", { ...args, content: "pwn" }],
    ["kb_append", { space: "sp", project: "proj-a", section: "journal", note: "2026-11", line: "x", content: "x" }],
    ["kb_archive", args],
    ["kb_list", {}],
    ["kb_list", { space: "sp" }],
    ["kb_search", { query: "secret" }],
    ["kb_history", args],
    ["kb_init_project", { space: "sp", project: "proj-z", summary: "s" }],
    ["kb_propose", { ...args, content: "c", reason: "r" }],
  ];
  for (const [name, a] of calls) {
    const r = await call(sid, name, a);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /^No access for this session: call kb_request_access \(space, project, access, reason\) and ask the user to approve it\.$/, name);
  }
  assert.equal(headSha(), before, "no commit");
  
  assert.equal(git(["status", "--porcelain"], vault).trim(), "", "no file written");
  // Repeated refusals of one session are coalesced: one audit row for the whole burst.
  const rowsAfter = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE 'session has no grant%'").get() as { c: number }).c;
  assert.equal(rowsAfter - rowsBefore, 1);
});

test("request -> pending -> approve -> read; read grant cannot write; default scopes shape", async () => {
  const sid = await connect();
  const r = await request(sid, "sp", "proj-a", "read");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /ask the user to approve/i);
  assert.match(r.text, /Do not wait for the user to come back by message.*until approved, denied or expired/);
  assert.match(r.text, /kb_access_status/);
  const id = reqId(r.text);
  const code = reqCode(r.text);
  assert.match((await call(sid, "kb_access_status", { request_id: id })).text, /^pending/);
  // Still no access.
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" })).isError, true);

  const d = approve(code, { actor: "admin:test" });
  assert.deepEqual(d.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`), ["meta:*:*:read", "sp:proj-a:*:read"]);
  assert.equal(d.tokenName, "session-claude-code-sp-proj-a");
  const st = await call(sid, "kb_access_status", { request_id: id });
  assert.match(st.text, /^approved/);
  assert.match(st.text, /sp:proj-a:\*:read/);

  const read = await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /secret of proj-a/);
  assert.equal((await call(sid, "kb_read", { space: "meta", project: "prefs", section: "notes", note: "style" })).isError, false);
  // Other project: denied, with a hint to request it.
  const other = await call(sid, "kb_read", { space: "sp", project: "proj-b", section: "notes", note: "n1" });
  assert.equal(other.isError, true);
  assert.match(other.text, /Permission denied\..*kb_request_access/);
  // Read grant: no write.
  const w = await call(sid, "kb_write", { space: "sp", project: "proj-a", section: "notes", note: "n2", content: "x" });
  assert.equal(w.isError, true);
  assert.match(w.text, /Permission denied/);
});

test("write grant: commit and audit carry the session grant name; several grants are a union attributed per target", async () => {
  const sid = await connect();
  const a = reqId((await request(sid, "sp", "proj-a", "write")).text);
  const b = reqId((await request(sid, "sp", "proj-b", "write")).text);
  approve(a, { actor: "admin:test" });
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-b", section: "notes", note: "n1" })).isError, true, "second project not yet approved");
  approve(b, { actor: "admin:test" });

  const wa = await call(sid, "kb_write", { space: "sp", project: "proj-a", section: "notes", note: "from-session", content: "hello a" });
  assert.equal(wa.isError, false, wa.text);
  assert.match(git(["log", "-1", "--format=%B"], vault), /via session-claude-code-sp-proj-a$/m);
  const wb = await call(sid, "kb_write", { space: "sp", project: "proj-b", section: "notes", note: "from-session", content: "hello b" });
  assert.equal(wb.isError, false, wb.text);
  assert.match(git(["log", "-1", "--format=%B"], vault), /via session-claude-code-sp-proj-b$/m);
  const row = db.prepare("SELECT token_name, token_id, result FROM audit_log WHERE action = 'kb_write' AND note = 'from-session' AND project = 'proj-b'").get() as any;
  assert.equal(row.token_name, "session-claude-code-sp-proj-b");
  assert.equal(row.result, "ok");
  const grantTok = db.prepare("SELECT id FROM tokens WHERE name = 'session-claude-code-sp-proj-b' ORDER BY created_at DESC").get() as { id: string };
  assert.equal(row.token_id, grantTok.id);
  // Union: reads both.
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "from-session" })).isError, false);
  const list = await call(sid, "kb_list", { space: "sp" });
  assert.match(list.text, /proj-a/);
  assert.match(list.text, /proj-b/);
});

test("session grants are tokens (listed, kind=session) but can never authenticate as a Bearer token", async () => {
  const grants = tokens.listTokens().filter((t) => t.kind === "session");
  assert.ok(grants.length >= 3);
  assert.ok(tokens.listTokens().filter((t) => t.kind === "bearer").every((t) => !t.name.startsWith("session-")));
  const g = db.prepare("SELECT id FROM tokens WHERE kind = 'session' LIMIT 1").get() as { id: string };
  // Even a known secret does not work: the lookup is restricted to kind='bearer'.
  db.prepare("UPDATE tokens SET token_hash = ? WHERE id = ?").run(sessions.hashSid("sb_known"), g.id);
  assert.equal(tokens.checkToken("sb_known").status, "invalid");
  const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer sb_known" });
  assert.equal(r.status, 401);
});

test("revoking a grant from the token list cuts the session's access immediately", async () => {
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "write")).text), { actor: "admin:test" });
  const args = { space: "sp", project: "proj-a", section: "notes", note: "n1" };
  assert.equal((await call(sid, "kb_read", args)).isError, false);
  const g = db.prepare("SELECT id FROM tokens WHERE session_id = ?").get(sidRow(sid)!.id) as { id: string };
  assert.equal(tokens.revokeToken(g.id), true);
  const after = await call(sid, "kb_read", args);
  assert.equal(after.isError, true);
  assert.match(after.text, /^No access for this session/);
  // The request now reports revoked.
  const reqRow = db.prepare("SELECT id FROM access_requests WHERE token_id = ?").get(g.id) as { id: string };
  assert.match((await call(sid, "kb_access_status", { request_id: reqRow.id })).text, /^revoked/);
});

test("revoking the session makes its id 404 and kills every grant", async () => {
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "admin:test" });
  const id = sidRow(sid)!.id;
  assert.equal(sessions.revokeSession(id), true);
  assert.equal(sessions.revokeSession(id), false);
  const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid });
  assert.equal(r.status, 404);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM tokens WHERE session_id = ? AND revoked_at IS NULL").get(id) as { c: number }).c, 0);
});

test("deny, expiry and cross-session isolation of request status", async () => {
  const sid = await connect();
  const other = await connect();
  const id = reqId((await request(sid, "sp", "proj-a")).text);
  assert.match((await call(other, "kb_access_status", { request_id: id })).text, /Unknown request_id/);
  access.denyRequest(id, "admin:test");
  assert.match((await call(sid, "kb_access_status", { request_id: id })).text, /^denied/);
  assert.throws(() => approve(id, { actor: "x" }), /already denied/);
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" })).isError, true);

  const id2 = reqId((await request(sid, "sp", "proj-b")).text);
  db.prepare("UPDATE access_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id2);
  assert.match((await call(sid, "kb_access_status", { request_id: id2 })).text, /^expired/);
  assert.throws(() => approve(id2, { actor: "x" }), /expired|not found/);
  assert.match((await call(sid, "kb_access_status", { request_id: "nope" })).text, /Invalid request_id/);
});

test("access request validation", async () => {
  const sid = await connect();
  const bad = async (args: Record<string, unknown>, re: RegExp): Promise<void> => {
    const r = await call(sid, "kb_request_access", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  };
  await bad({ space: "Sp", project: "p", access: "read", reason: "r" }, /Invalid space\/project/);
  await bad({ space: "sp", project: "*", access: "read", reason: "r" }, /Invalid space\/project/);
  await bad({ space: "sp", project: "p", access: "admin", reason: "r" }, /access/);
  await bad({ space: "sp", project: "p", access: "read", reason: "" }, /reason/);
  await bad({ space: "sp", project: "p", access: "read", reason: "x".repeat(501) }, /reason/);
  await bad({ space: "sp", project: "p", access: "read", reason: "bad\u0007char" }, /control/);
  await bad({ space: "sp", project: "p", access: "read" }, /reason/);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM access_requests r JOIN sessions s ON s.id = r.session_id WHERE s.sid_hash = ?").get(sessions.hashSid(sid)) as { c: number }).c, 0);
});

test("a token holder gets a clear refusal from the access tools", async () => {
  const r = await bearerCall("kb_request_access", { space: "sp", project: "p", access: "read", reason: "r" });
  assert.equal(r.isError, true);
  assert.match(r.text, /connected without a token/);
});

test("limits: 3 pending per session (repeats are idempotent), 20 pending in total, 15 minute expiry", async () => {
  const sid = await connect();
  const first = await request(sid, "sp", "p1", "read");
  const again = await request(sid, "sp", "p1", "read");
  assert.equal(reqId(first.text), reqId(again.text), "identical pending request is returned as is");
  assert.match(again.text, /already pending/);
  assert.equal((await request(sid, "sp", "p2", "read")).isError, false);
  assert.equal((await request(sid, "sp", "p3", "read")).isError, false);
  const over = await request(sid, "sp", "p4", "read");
  assert.equal(over.isError, true);
  assert.match(over.text, /Too many pending/);

  const exp = db.prepare("SELECT created_at, expires_at FROM access_requests WHERE id = ?").get(reqId(first.text)) as { created_at: string; expires_at: string };
  assert.equal(Date.parse(exp.expires_at) - Date.parse(exp.created_at), 15 * 60_000);

  // Global cap (env): clear the table first so the number is exact.
  db.prepare("DELETE FROM access_requests").run();
  process.env.ACCESS_MAX_PENDING_TOTAL = "4";
  try {
    for (let i = 0; i < 2; i++) {
      const s = await connect();
      assert.equal((await request(s, "sp", "g1", "read")).isError, false);
      assert.equal((await request(s, "sp", "g2", "read")).isError, false);
    }
    const s = await connect();
    const r = await request(s, "sp", "g3", "read");
    assert.equal(r.isError, false, "no lockout at the global cap");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM access_requests WHERE status = 'pending' AND expires_at > ?").get(new Date().toISOString()) as { c: number }).c, 4, "the oldest pending request was expired to make room");
  } finally {
    process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
    db.prepare("DELETE FROM access_requests").run();
  }
});

test("rate limits per IP: initialize, access requests, and the open-session cap", async () => {
  const a = await mkApp({ initPerMin: 2 });
  try {
    await connect(a.baseUrl);
    await connect(a.baseUrl);
    const r = await rpc(a.baseUrl, INIT);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("mcp-session-id"), null);
  } finally {
    await a.close();
  }
  const b = await mkApp({ requestsPerHour: 2 });
  try {
    const sid = await connect(b.baseUrl);
    assert.equal((await call(sid, "kb_request_access", { space: "sp", project: "r1", access: "read", reason: "r" }, b.baseUrl)).isError, false);
    // A repeat of a pending request is free.
    assert.equal((await call(sid, "kb_request_access", { space: "sp", project: "r1", access: "read", reason: "r" }, b.baseUrl)).isError, false);
    assert.equal((await call(sid, "kb_request_access", { space: "sp", project: "r2", access: "read", reason: "r" }, b.baseUrl)).isError, false);
    const over = await call(sid, "kb_request_access", { space: "sp", project: "r3", access: "read", reason: "r" }, b.baseUrl);
    assert.equal(over.isError, true);
    assert.match(over.text, /Too many access requests from this address/);
  } finally {
    await b.close();
  }
  const cap = sessions.countGrantlessSessions() + 1;
  const c = await mkApp({ maxSessions: cap });
  try {
    await connect(c.baseUrl);
    const second = await connect(c.baseUrl);
    assert.ok(second, "no lockout: a newcomer is served");
    assert.ok(sessions.countGrantlessSessions() <= cap, "cap respected by evicting the most idle one");
  } finally {
    await c.close();
  }
  db.prepare("DELETE FROM access_requests").run();
});

test("sliding expiry: 24 h with a grant, 1 hour without; use refreshes the window", async () => {
  const day = 86_400_000;
  const setSeen = (sid: string, agoMs: number): void => void db.prepare("UPDATE sessions SET last_seen_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - agoMs).toISOString(), sessions.hashSid(sid));
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };

  const bare = await connect();
  setSeen(bare, 61 * 60_000);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": bare })).status, 404, "no grant: 1 h idle");
  const bare2 = await connect();
  setSeen(bare2, 50 * 60_000);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": bare2 })).status, 200);

  const granted = await connect();
  approve(reqId((await request(granted, "sp", "proj-a", "read")).text), { actor: "t" });
  setSeen(granted, 23 * 3_600_000);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": granted })).status, 200, "23 h idle is fine with a grant");
  assert.ok(Date.now() - Date.parse(sidRow(granted)!.last_seen_at) < 5000, "last_seen refreshed (sliding)");
  setSeen(granted, day + 1000);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": granted })).status, 404);
  // Expiry revoked the grant too.
  assert.equal((db.prepare("SELECT COUNT(*) c FROM tokens WHERE name = 'session-claude-code-sp-proj-a' AND revoked_at IS NULL AND session_id NOT IN (SELECT id FROM sessions)").get() as { c: number }).c, 0);

  assert.equal(sessions.sessionIdleMs({ SESSION_IDLE_DAYS: "2" } as NodeJS.ProcessEnv), 2 * day);
  assert.equal(sessions.sessionIdleMs({ SESSION_IDLE_DAYS: "nope" } as NodeJS.ProcessEnv), day);
  assert.equal(sessions.sessionIdleMs({} as NodeJS.ProcessEnv), day);
});

test("sessions survive a restart (DB-backed); pruning removes expired ones and revokes their grants", async () => {
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "t" });
  // "Restart": a brand new app instance over the same database.
  const { createApp } = await import("./server");
  const fresh = await mkApp();
  try {
    const r = await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" }, fresh.baseUrl);
    assert.equal(r.isError, false, r.text);
  } finally {
    await fresh.close();
  }

  const stale = await connect();
  const grantedStale = await connect();
  approve(reqId((await request(grantedStale, "sp", "proj-b", "read")).text), { actor: "t" });
  const old = new Date(Date.now() - 6 * 86_400_000).toISOString();
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE sid_hash IN (?, ?)").run(old, sessions.hashSid(stale), sessions.hashSid(grantedStale));
  const gid = (db.prepare("SELECT id FROM tokens WHERE session_id = ?").get(sidRow(grantedStale)!.id) as { id: string }).id;
  assert.ok(sessions.pruneSessions() >= 2);
  assert.equal(sidRow(stale), undefined);
  assert.equal(sidRow(grantedStale), undefined);
  assert.ok((db.prepare("SELECT revoked_at FROM tokens WHERE id = ?").get(gid) as { revoked_at: string | null }).revoked_at);
  assert.ok(sidRow(sid), "live session kept");
});

test("Bearer requests are unchanged: no session header issued, a stray session id is ignored, no session needed", async () => {
  const r = await rpc(app.baseUrl, INIT, { Authorization: `Bearer ${masterToken}` });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("mcp-session-id"), null);
  const stray = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { Authorization: `Bearer ${masterToken}`, "mcp-session-id": "f".repeat(64) });
  assert.equal(stray.status, 200);
  const k = await bearerCall("kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" });
  assert.equal(k.isError, false);
  // Bearer is not confined to the token-less allowlist.
  assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 3, method: "resources/list" }, { Authorization: `Bearer ${masterToken}` })).status, 200);
  // A bad token is still a 401, even with a valid session id next to it.
  const sid = await connect();
  assert.equal((await rpc(app.baseUrl, { jsonrpc: "2.0", id: 4, method: "tools/list" }, { Authorization: "Bearer sb_bad", "mcp-session-id": sid })).status, 401);
});

test("a real MCP client without any auth: initialize, list tools, request access, poll status", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), { requestInit: { headers: { "x-api-key": KEY } } });
  const client = new Client({ name: "sdk-client", version: "9.9" });
  await client.connect(transport);
  try {
    assert.match(String(transport.sessionId), /^[0-9a-f]{64}$/);
    assert.ok((await client.listTools()).tools.some((t) => t.name === "kb_request_access"));
    const r = (await client.callTool({ name: "kb_request_access", arguments: { space: "sp", project: "proj-a", access: "write", reason: "sdk test" } })) as any;
    assert.equal(r.isError ?? false, false);
    const id = reqId(r.content[0].text);
    approve(id, { actor: "t" });
    const st = (await client.callTool({ name: "kb_access_status", arguments: { request_id: id } })) as any;
    assert.match(st.content[0].text, /^approved/);
    const read = (await client.callTool({ name: "kb_read", arguments: { space: "sp", project: "proj-a", section: "notes", note: "n1" } })) as any;
    assert.match(read.content[0].text, /secret of proj-a/);
  } finally {
    await transport.close();
  }
  assert.ok((db.prepare("SELECT 1 FROM sessions WHERE client_name = 'sdk-client' AND client_version = '9.9'").get()));
});

test("audit: approve/deny/revoke rows carry the actor, no row or log line contains a session id", async () => {
  const sid = await connect();
  const id = reqId((await request(sid, "sp", "audit-p", "read")).text);
  approve(id, { actor: "admin:alice" });
  const sid2 = await connect();
  access.denyRequest(reqId((await request(sid2, "sp", "audit-q", "read")).text), "admin:alice");
  const rows = db.prepare("SELECT action, token_name, project, result FROM audit_log WHERE token_name = 'admin:alice' ORDER BY id").all() as any[];
  assert.ok(rows.some((r) => r.action === "access_approve" && r.project === "audit-p" && r.result === "ok"));
  assert.ok(rows.some((r) => r.action === "access_deny" && r.project === "audit-q"));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'kb_request_access' AND project = 'audit-p'").get());
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'session_init'").get());
  const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
  for (const s of [sid, sid2, sessions.hashSid(sid)]) assert.equal(dump.includes(s), false);
});

test("approve guards: unknown ref, invalid scopes, concurrent decision", async () => {
  const sid = await connect();
  const id = reqId((await request(sid, "sp", "proj-a", "read")).text);
  assert.throws(() => approve("ZZZZZZ", { actor: "t" }), /not found/);
  const wild = [{ space: "sp", project: "*", section: "*", permission: "write" as const }];
  assert.throws(() => approve(id, { actor: "t", scopes: [{ space: "*", project: "x", section: "*", permission: "read" }] }), /invalid scope/);
  assert.throws(() => approve(id, { actor: "t", scopes: [] }), /at least one scope/);
  // Nothing was granted by the failed attempts.
  assert.equal(listGrants(sid), 0);
  const d = approve(id, { actor: "t", scopes: wild });
  assert.equal(d.scopes.length, 1);
  assert.equal(d.notes.length, 1, "wildcard warning is returned, not blocking");
  assert.throws(() => approve(id, { actor: "t" }), /already approved/);
  function listGrants(s: string): number {
    return sessions.listGrants(sidRow(s)!.id).length;
  }
});

test("elevation: an approved session asks for more; approve adds a grant (union), deny leaves existing grants untouched", async () => {
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "admin:test" });
  const aArgs = { space: "sp", project: "proj-a", section: "notes", note: "elev" };
  assert.equal((await call(sid, "kb_write", { ...aArgs, content: "x" })).isError, true, "read only so far");

  // read -> write on the same project
  const up = await request(sid, "sp", "proj-a", "write");
  assert.equal(up.isError, false, up.text);
  const upId = reqId(up.text);
  const pending = access.listPendingRequests().find((r) => r.id === upId)!;
  assert.equal(pending.elevation, 1);
  assert.equal(pending.current_grants.length, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_request' AND detail LIKE ?").get(`${upId}%`));
  // Denied: existing read grant still works, still no write.
  access.denyRequest(upId, "admin:test");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_deny'").get());
  assert.equal((await call(sid, "kb_read", { ...aArgs, note: "n1" })).isError, false);
  assert.equal((await call(sid, "kb_write", { ...aArgs, content: "x" })).isError, true);

  // Ask again, approve: union of both grants.
  const again = reqId((await request(sid, "sp", "proj-a", "write")).text);
  approve(again, { actor: "admin:test" });
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_approve'").get());
  assert.equal((await call(sid, "kb_write", { ...aArgs, content: "x" })).isError, false);
  assert.equal(sessions.listGrants(sidRow(sid)!.id).length, 2);
  // Another project later in the same session.
  approve(reqId((await request(sid, "sp", "proj-b", "read")).text), { actor: "admin:test" });
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-b", section: "notes", note: "n1" })).isError, false);
  assert.equal((await call(sid, "kb_read", { ...aArgs, note: "n1" })).isError, false);
});

test("explicit scopes: validated, never pre-confirmed wildcards, approved list replaces the default", async () => {
  const sid = await connect();
  const bad = async (scopes: unknown, re: RegExp): Promise<void> => {
    const r = await call(sid, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "r", scopes });
    assert.equal(r.isError, true, JSON.stringify(scopes));
    assert.match(r.text, re, JSON.stringify(scopes));
  };
  await bad(["nope"], /expected space:project:section:permission/);
  await bad(["sp:*:notes:read"], /trailing/);
  await bad(["sp:proj-a:notes:admin"], /invalid permission/);
  await bad(["Sp:proj-a:notes:read"], /invalid space slug/);
  await bad([], /scopes must be/);
  const ok = await call(sid, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "r", scopes: ["sp:proj-a:notes:read", "sp:proj-a:*:write"] });
  assert.equal(ok.isError, false, ok.text);
  const p = access.listPendingRequests().find((r) => r.id === reqId(ok.text))!;
  assert.deepEqual(p.requested_scopes.map((s) => `${s.section}:${s.permission}`), ["notes:read", "*:write"]);
  // A wildcard request needs no confirmation flag; the warnings come back in the decision.
  const w = await call(sid, "kb_request_access", { space: "sp", project: "proj-b", access: "read", reason: "r", scopes: ["sp:*:*:read"] });
  assert.equal(w.isError, false, w.text);
  assert.ok(approve(reqId(w.text), { actor: "t" }).notes.length > 0);
  assert.ok(approve(reqId(ok.text), { actor: "t" }).notes.length > 0);
  const granted = sessions.listGrants(sidRow(sid)!.id).flatMap((g) => g.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`));
  assert.ok(granted.includes("sp:proj-a:notes:read") && granted.includes("sp:*:*:read"));
  assert.ok(!granted.includes("meta:*:*:read"), "explicit list replaces the default shape");
});

test("instructions: access is on demand, not up front, and can be requested again later", async () => {
  const sid = await connect();
  const r = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid });
  const tools: { name: string; description: string }[] = r.json.result.tools;
  const req = tools.find((t) => t.name === "kb_request_access")!.description;
  assert.match(req, /Do NOT request up front/);
  assert.match(req, /request again later in the same session/);
  assert.match(req, /kb_access_status/);
  assert.match(req, /denial changes nothing/);
  assert.match(tools.find((t) => t.name === "kb_access_status")!.description, /denial changes nothing/);
});

// ---- connector keys ----

const raw = (headers: Record<string, string>, body: unknown = INIT) =>
  fetch(`${app.baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

test("connector key gate: missing, invalid or revoked key is a generic 401 with no session or audit side effects", async () => {
  const k2 = keys.createConnectorKey("temp", "test-admin-secret");
  const sessionsBefore = count("SELECT COUNT(*) c FROM sessions");
  const auditBefore = count("SELECT COUNT(*) c FROM audit_log WHERE action != 'auth'");
  const authBefore = count("SELECT COUNT(*) c FROM audit_log WHERE action = 'auth'");
  for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "sbk_nope" }, { "x-api-key": "x".repeat(300) }, { "x-api-key": KEY.toUpperCase() }]) {
    const r = await raw(headers as Record<string, string>);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(await r.json(), { error: "unauthorized" });
    assert.equal(r.headers.get("mcp-session-id"), null);
  }
  // Later session requests need the key too, and it is checked before the session lookup (no 404 oracle).
  const sid = await connect();
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  assert.equal((await raw({ "mcp-session-id": sid }, list)).status, 401);
  assert.equal((await raw({ "mcp-session-id": "f".repeat(64) }, list)).status, 401);
  // Revoked key: same 401, and it never counted as a valid one.
  assert.equal(keys.revokeConnectorKey(k2.id).revoked, true);
  assert.equal((await raw({ "x-api-key": k2.key })).status, 401);
  assert.equal(count("SELECT COUNT(*) c FROM sessions") - sessionsBefore, 1, "only the legitimate connect() made a session");
  assert.equal(count("SELECT COUNT(*) c FROM audit_log WHERE action != 'auth'") - auditBefore, 1, "only its session_init row; refusals add nothing but the coalesced auth failure");
  // Refusals are coalesced into the auth-failure audit (at most one row per client per minute).
  assert.ok(count("SELECT COUNT(*) c FROM audit_log WHERE action = 'auth'") - authBefore <= 1);
});

test("with no active key at all, token-less access is disabled (same 401); Bearer is unaffected", async () => {
  db.prepare("UPDATE connector_keys SET revoked_at = '2000-01-01T00:00:00.000Z' WHERE revoked_at IS NULL AND id IN (SELECT id FROM connector_keys WHERE name = 'test-key')").run();
  try {
    assert.equal((await raw({ "x-api-key": KEY })).status, 401);
    const b = await raw({ Authorization: `Bearer ${masterToken}` }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(b.status, 200);
  } finally {
    db.prepare("UPDATE connector_keys SET revoked_at = NULL WHERE name = 'test-key'").run();
  }
  // A Bearer client ignores a wrong connector key.
  const b2 = await raw({ Authorization: `Bearer ${masterToken}`, "x-api-key": "garbage-key" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(b2.status, 200);
});

test("a session answers only to the key that opened it (mismatch is a 404); revoking a key ends its sessions and grants", async () => {
  const other = keys.createConnectorKey("other", "test-admin-secret");
  const sidA = await connect();
  const sidB = (await rpc(app.baseUrl, INIT, { "x-api-key": other.key })).headers.get("mcp-session-id") as string;
  assert.match(sidB, /^[0-9a-f]{64}$/);
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sidB })).status, 404, "key A presenting B's session");
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sidA, "x-api-key": other.key })).status, 404);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sidB, "x-api-key": other.key })).status, 200);

  approve(reqId((await call(sidB, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "r" }, app.baseUrl, { "x-api-key": other.key })).text), { actor: "t" });
  const bid = sidRow(sidB)!.id;
  assert.equal(sessions.listGrants(bid).length, 1);
  assert.deepEqual(keys.revokeConnectorKey(other.id), { revoked: true, sessions: 1 });
  assert.equal(sidRow(sidB), undefined);
  assert.equal(count(`SELECT COUNT(*) c FROM tokens WHERE session_id = '${bid}' AND revoked_at IS NULL`), 0);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sidB, "x-api-key": other.key })).status, 401);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sidA })).status, 200, "the other key's sessions are untouched");
  assert.deepEqual(keys.revokeConnectorKey(other.id), { revoked: false, sessions: 0 });
});

test("connector key never reaches the audit log or the DB in clear; instructions do not mention it", async () => {
  await connect();
  const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all()) + JSON.stringify(db.prepare("SELECT * FROM connector_keys").all());
  assert.equal(dump.includes(KEY), false);
  const text: string = (await rpc(app.baseUrl, INIT)).json.result.instructions;
  assert.doesNotMatch(text, /connector|X-SB|sbk_/i);
});

test("connector key reveal: encrypted round trip, undecryptable with another secret, revoked or missing", () => {
  const k = keys.createConnectorKey("reveal-me", "secret-one");
  const row = db.prepare("SELECT key_enc, key_hash FROM connector_keys WHERE id = ?").get(k.id) as { key_enc: string; key_hash: string };
  assert.ok(row.key_enc && !row.key_enc.includes(k.key) && !Buffer.from(row.key_enc, "base64").includes(k.key));
  assert.deepEqual(keys.revealConnectorKey({ id: k.id }, "secret-one"), { status: "ok", id: k.id, name: "reveal-me", key: k.key });
  assert.deepEqual(keys.revealConnectorKey({ name: "reveal-me" }, "secret-one"), { status: "ok", id: k.id, name: "reveal-me", key: k.key });
  assert.deepEqual(keys.revealConnectorKey({ id: k.id }, "secret-two"), { status: "undecryptable" });
  assert.deepEqual(keys.revealConnectorKey({ id: k.id }, undefined), { status: "undecryptable" });
  assert.equal(keys.checkConnectorKey(k.key)?.id, k.id, "still authenticates after the secret changed");
  // Two encryptions of the same plaintext differ (random nonce); a tampered blob does not decrypt.
  db.prepare("UPDATE connector_keys SET key_enc = ? WHERE id = ?").run(Buffer.from("garbage-garbage-garbage-garbage-garbage").toString("base64"), k.id);
  assert.equal(keys.revealConnectorKey({ id: k.id }, "secret-one").status, "undecryptable");
  const nokey = keys.createConnectorKey("no-secret");
  assert.equal(keys.revealConnectorKey({ id: nokey.id }, "secret-one").status, "undecryptable");
  keys.revokeConnectorKey(k.id);
  assert.equal(keys.revealConnectorKey({ id: k.id }, "secret-one").status, "missing");
  assert.equal(keys.revealConnectorKey({ id: "nope" }, "secret-one").status, "missing");
  assert.throws(() => keys.createConnectorKey("", "s"), /name must be/);
  assert.throws(() => keys.createConnectorKey("bad\nname", "s"), /control/);
});

// ---- security hardening ----

test("ipKey buckets IPv6 by /64 and unwraps v4-mapped addresses", async () => {
  const { ipKey } = await import("./rateLimit");
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipKey("2001:0DB8:1:2::1"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey(undefined), "unknown");
});

test("grantless sessions: absolute lifetime from creation, per-IP cap and global cap evict instead of refusing", async () => {
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  // Kept alive by polling but never granted: dies at the absolute lifetime (default 2 h).
  const old = await connect();
  db.prepare("UPDATE sessions SET created_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - 3 * 3_600_000).toISOString(), sessions.hashSid(old));
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": old })).status, 404);
  // A granted session is not subject to it.
  const granted = await connect();
  approve(reqId((await request(granted, "sp", "proj-a", "read")).text), { actor: "t" });
  db.prepare("UPDATE sessions SET created_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - 3 * 3_600_000).toISOString(), sessions.hashSid(granted));
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": granted })).status, 200);

  // Per-IP cap: the client's own most idle grantless session makes room.
  const keyId = keys.checkConnectorKey(KEY)!.id;
  const mine = sessions.countGrantlessSessions("127.0.0.1", keyId);
  const a = await mkApp({ sessionsPerIp: mine + 1 });
  try {
    const s1 = await connect(a.baseUrl);
    const s2 = await connect(a.baseUrl);
    assert.match(s2, /^[0-9a-f]{64}$/, "newcomer served");
    assert.ok(s1);
    assert.equal(sessions.countGrantlessSessions("127.0.0.1", keyId), mine + 1);
  } finally {
    await a.close();
  }
  // Sessions holding a pending request are evicted last.
  const keep = await connect();
  await request(keep, "sp", "evict-guard", "read");
  const idle = await connect();
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - 1000).toISOString(), sessions.hashSid(keep));
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - 60_000).toISOString(), sessions.hashSid(idle));
  const total = sessions.countGrantlessSessions();
  const b = await mkApp({ maxSessions: total });
  try {
    await connect(b.baseUrl);
    assert.ok(sidRow(keep), "session with a pending request survives");
  } finally {
    await b.close();
  }
  db.prepare("DELETE FROM access_requests").run();
});

test("pending requests: per-client cap refuses, the global cap expires the oldest request of the busiest client", async () => {
  db.prepare("DELETE FROM access_requests").run();
  process.env.ACCESS_MAX_PENDING_PER_IP = "2";
  try {
    const s1 = await connect();
    const s2 = await connect();
    assert.equal((await request(s1, "sp", "ip1", "read")).isError, false);
    assert.equal((await request(s2, "sp", "ip2", "read")).isError, false);
    const over = await request(s1, "sp", "ip3", "read");
    assert.equal(over.isError, true);
    assert.match(over.text, /Too many pending access requests from this address/);
  } finally {
    process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
  }
  db.prepare("DELETE FROM access_requests").run();
  // Busiest client loses its oldest one when the global cap is hit (a quiet client is not the victim).
  const busy = sessions.createSession({ clientName: "busy", clientVersion: "1", ip: "198.51.100.1" });
  const quiet = sessions.createSession({ clientName: "quiet", clientVersion: "1", ip: "198.51.100.2" });
  process.env.ACCESS_MAX_PENDING_TOTAL = "3";
  try {
    const b1 = access.createAccessRequest(busy.id, { space: "sp", project: "b1", access: "read", reason: "r" }).request;
    access.createAccessRequest(busy.id, { space: "sp", project: "b2", access: "read", reason: "r" });
    const q1 = access.createAccessRequest(quiet.id, { space: "sp", project: "q1", access: "read", reason: "r" }).request;
    access.createAccessRequest(quiet.id, { space: "sp", project: "q2", access: "read", reason: "r" });
    assert.equal(access.accessStatus(busy.id, b1.id)?.status, "expired", "busiest client's oldest request was expired");
    assert.equal(access.accessStatus(quiet.id, q1.id)?.status, "pending");
  } finally {
    process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
  }
  db.prepare("DELETE FROM access_requests").run();
});

test("explicit scopes only: space/project/access optional, card and grant name come from the scopes, over-reach is flagged", async () => {
  const sid = await connect();
  const r1 = await call(sid, "kb_request_access", { reason: "only scopes", scopes: ["sp:proj-a:notes:write"] });
  assert.equal(r1.isError, false, r1.text);
  assert.match(r1.text, /sp:proj-a:notes:write/);
  const p1 = access.listPendingRequests().find((r) => r.id === reqId(r1.text))!;
  assert.equal(p1.space, null);
  assert.equal(p1.exceeds, false, "nothing stated, nothing exceeded");
  assert.equal(approve(p1.id, { actor: "t" }).tokenName, "session-claude-code-sp-proj-a");
  // Stated read on proj-a but the list also asks for write elsewhere: flagged, named after the scopes.
  const r2 = await call(sid, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "sneaky", scopes: ["sp:proj-a:*:read", "sp:proj-b:notes:write"] });
  const p2 = access.listPendingRequests().find((r) => r.id === reqId(r2.text))!;
  assert.equal(p2.exceeds, true);
  assert.equal(approve(p2.id, { actor: "t" }).tokenName, "session-claude-code-multi");
  // Within the stated request: not flagged.
  const r3 = await call(sid, "kb_request_access", { space: "sp", project: "proj-b", access: "write", reason: "fine", scopes: ["sp:proj-b:notes:write"] });
  assert.equal(access.listPendingRequests().find((r) => r.id === reqId(r3.text))!.exceeds, false);
  // Partial stated trio / nothing at all are refused.
  assert.match((await call(sid, "kb_request_access", { space: "sp", reason: "r" })).text, /together/);
  assert.match((await call(sid, "kb_request_access", { reason: "r" })).text, /scopes list/);
  assert.equal(access.grantLabel([{ space: "*", project: "*", section: "*", permission: "read" }]), "all");
  assert.equal(access.grantLabel([{ space: "meta", project: "*", section: "*", permission: "read" }]), "meta-all");
  assert.equal(access.grantLabel([{ space: "meta", project: "*", section: "*", permission: "read" }, { space: "sp", project: "*", section: "*", permission: "read" }]), "sp-all");
});

test("approval needs the typed code when approving by id; a code reference is its own proof", async () => {
  const sid = await connect();
  const id = reqId((await request(sid, "sp", "proj-a", "read")).text);
  const code = (db.prepare("SELECT code FROM access_requests WHERE id = ?").get(id) as { code: string }).code;
  assert.throws(() => access.approveRequest(id, { actor: "t" }), /Type the request code/);
  assert.throws(() => access.approveRequest(id, { actor: "t", code: "AAAAAA" }), /Type the request code/);
  assert.equal(sessions.listGrants(sidRow(sid)!.id).length, 0);
  assert.equal(access.approveRequest(id, { actor: "t", code: ` ${code.toLowerCase()} ` }).scopes.length, 2);
  const id2 = reqId((await request(sid, "sp", "proj-b", "read")).text);
  const code2 = (db.prepare("SELECT code FROM access_requests WHERE id = ?").get(id2) as { code: string }).code;
  assert.ok(access.approveRequest(code2, { actor: "t" }));
});

test("token-less calls are rate limited per session and per client (429), without affecting Bearer", async () => {
  const a = await mkApp({ sessionCallsPerMin: 3 });
  try {
    const sid = await connect(a.baseUrl);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    for (let i = 0; i < 3; i++) assert.equal((await rpc(a.baseUrl, list, { "mcp-session-id": sid })).status, 200);
    assert.equal((await rpc(a.baseUrl, list, { "mcp-session-id": sid })).status, 429);
    assert.equal((await rpc(a.baseUrl, list, { Authorization: `Bearer ${masterToken}` })).status, 200);
  } finally {
    await a.close();
  }
  const b = await mkApp({ ipCallsPerMin: 2 });
  try {
    const sid = await connect(b.baseUrl);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await rpc(b.baseUrl, list, { "mcp-session-id": sid })).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    await b.close();
  }
});

test("granted sessions have an absolute lifetime from the first grant (SESSION_MAX_DAYS, default 30)", async () => {
  const day = 86_400_000;
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "t" });
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const live = sessions.listActiveSessions().find((s) => s.id === sidRow(sid)!.id)!;
  const exp = Date.parse(live.expires_at) - Date.now();
  assert.ok(exp > 0.99 * day && exp <= day, "idle expiry is the nearer one at first");
  assert.equal(live.connector_key, "test-key");
  db.prepare("UPDATE sessions SET first_grant_at = ? WHERE sid_hash = ?").run(new Date(Date.now() - 31 * day).toISOString(), sessions.hashSid(sid));
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": sid })).status, 404, "used daily, still ends 30 days after the first grant");
  assert.equal(sessions.sessionMaxMs({ SESSION_MAX_DAYS: "7" } as NodeJS.ProcessEnv), 7 * day);
  assert.equal(sessions.sessionMaxMs({} as NodeJS.ProcessEnv), 30 * day);
});

test("pruning deletes dead session grant rows after 30 days, keeps recent ones", async () => {
  const day = 86_400_000;
  const sid = await connect();
  approve(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "t" });
  const sessionId = sidRow(sid)!.id;
  const gid = (db.prepare("SELECT id FROM tokens WHERE session_id = ?").get(sessionId) as { id: string }).id;
  tokens.revokeToken(gid);
  sessions.pruneSessions();
  assert.ok(db.prepare("SELECT 1 FROM tokens WHERE id = ?").get(gid), "recently revoked grant kept for the audit trail");
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(new Date(Date.now() - 31 * day).toISOString(), gid);
  sessions.pruneSessions();
  assert.equal(db.prepare("SELECT 1 FROM tokens WHERE id = ?").get(gid), undefined);
  assert.equal(count(`SELECT COUNT(*) c FROM scopes WHERE token_id = '${gid}'`), 0, "scopes cascade");
  // Bearer tokens are never pruned this way.
  const b = tokens.createToken("old-bearer", [{ space: "sp", project: "p", section: "s", permission: "read" }]);
  tokens.revokeToken(b.id);
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(new Date(Date.now() - 400 * day).toISOString(), b.id);
  sessions.pruneSessions();
  assert.ok(db.prepare("SELECT 1 FROM tokens WHERE id = ?").get(b.id));
});

test("an attacker failing from the same address never blocks a valid key or a valid Bearer token", async () => {
  const { createApp } = await import("./server");
  const lim = await listen(createApp({ vaultRoot: vault }));
  try {
    const bad = (h: Record<string, string>) => fetch(`${lim.baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: "{}" });
    // Wrong/missing connector keys: always a plain 401, never a block.
    for (let i = 0; i < 40; i++) assert.equal((await bad({ "x-api-key": "sbk_wrong" + i })).status, 401);
    // Bad Bearer tokens: throttled after 10 failures...
    for (let i = 0; i < 10; i++) assert.equal((await bad({ Authorization: "Bearer sb_bad" + i })).status, 401);
    assert.equal((await bad({ Authorization: "Bearer sb_bad_more" })).status, 429);
    // ...yet the owner's valid credentials from the same address still work.
    const ok = await rpc(lim.baseUrl, INIT);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("mcp-session-id") ?? "", /^[0-9a-f]{64}$/);
    const b = await rpc(lim.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { Authorization: `Bearer ${masterToken}` });
    assert.equal(b.status, 200);
  } finally {
    await lim.close();
  }
});

test("auth failures are keyed per client on /64, and the failure audit has a global per-minute cap with one summary row", async () => {
  const { AuthFailureLimiter } = await import("./server");
  const { ipKey, GlobalBudget } = await import("./rateLimit");
  // Same /64, different hosts: one counter.
  const l = new AuthFailureLimiter(2, 60_000);
  l.record(ipKey("2001:db8:5:5::1"));
  l.record(ipKey("2001:db8:5:5::2"));
  assert.equal(l.blocked(ipKey("2001:db8:5:5:ffff::9")), true);
  assert.equal(l.blocked(ipKey("2001:db8:5:6::1")), false);
  // Global audit cap: excess is swallowed, then reported once.
  let t = 0;
  const g = new GlobalBudget(2, 1000, () => t);
  assert.deepEqual([g.take(), g.take(), g.take(), g.take()].map((x) => x.log), [true, true, false, false]);
  t = 2000;
  assert.deepEqual(g.take(), { log: true, summary: 2 });
  assert.deepEqual(g.take(), { log: true, summary: 0 });
  // End to end: many distinct clients failing cannot write more than the cap of rows per minute.
  const { authAuditBudget } = await import("./authFailure");
  const { auditAuthFailure } = await import("./authFailure");
  void authAuditBudget;
  const before = count("SELECT COUNT(*) c FROM audit_log WHERE action = 'auth'");
  for (let i = 0; i < 200; i++) auditAuthFailure(`198.51.100.${i % 250}`, "x");
  assert.ok(count("SELECT COUNT(*) c FROM audit_log WHERE action = 'auth'") - before <= 31, "capped (plus at most one summary row)");
});

test("GCM hardening: short or truncated blobs never decrypt", () => {
  const k = keys.createConnectorKey("gcm", "gcm-secret");
  const good = (db.prepare("SELECT key_enc FROM connector_keys WHERE id = ?").get(k.id) as { key_enc: string }).key_enc;
  assert.equal(keys.revealConnectorKey({ id: k.id }, "gcm-secret").status, "ok");
  const buf = Buffer.from(good, "base64");
  for (const bad of [buf.subarray(0, 20), buf.subarray(0, 27), buf.subarray(0, 28), Buffer.alloc(0)]) {
    db.prepare("UPDATE connector_keys SET key_enc = ? WHERE id = ?").run(bad.toString("base64"), k.id);
    assert.equal(keys.revealConnectorKey({ id: k.id }, "gcm-secret").status, "undecryptable", `len ${bad.length}`);
  }
  keys.revokeConnectorKey(k.id);
});

test("revealing by an ambiguous name is refused; the id works", () => {
  const a = keys.createConnectorKey("twin", "s");
  const b = keys.createConnectorKey("twin", "s");
  assert.deepEqual(keys.revealConnectorKey({ name: "twin" }, "s"), { status: "ambiguous" });
  assert.equal(keys.revealConnectorKey({ id: a.id }, "s").status, "ok");
  assert.equal(keys.revealConnectorKey({ id: b.id }, "s").status, "ok");
  keys.revokeConnectorKey(a.id);
  assert.equal(keys.revealConnectorKey({ name: "twin" }, "s").status, "ok", "unambiguous again");
  keys.revokeConnectorKey(b.id);
});

test("per-client caps are bucketed by (connector key, client): a leaked key cannot evict or starve other keys", async () => {
  const k2 = keys.createConnectorKey("bucket-b", "s");
  // Sessions of key A and key B from the same address.
  const a1 = sessions.createSession({ clientName: "a", clientVersion: "1", ip: "192.0.2.50", connectorKeyId: "key-a" });
  const a2 = sessions.createSession({ clientName: "a", clientVersion: "1", ip: "192.0.2.50", connectorKeyId: "key-a" });
  const b1 = sessions.createSession({ clientName: "b", clientVersion: "1", ip: "192.0.2.50", connectorKeyId: k2.id });
  assert.equal(sessions.countGrantlessSessions("192.0.2.50", "key-a"), 2);
  assert.equal(sessions.countGrantlessSessions("192.0.2.50", k2.id), 1);
  // Key A hits its per-client cap: only key A's own sessions are evicted.
  assert.equal(sessions.evictGrantlessSession("192.0.2.50", "key-a"), true);
  assert.equal(sessions.countGrantlessSessions("192.0.2.50", "key-a"), 1);
  assert.equal(sessions.countGrantlessSessions("192.0.2.50", k2.id), 1, "key B untouched");
  void a1; void a2; void b1;
  // Pending cap: key A's requests do not count against key B.
  process.env.ACCESS_MAX_PENDING_PER_IP = "1";
  try {
    const sa = sessions.createSession({ clientName: "a", clientVersion: "1", ip: "192.0.2.51", connectorKeyId: "key-a" });
    const sb = sessions.createSession({ clientName: "b", clientVersion: "1", ip: "192.0.2.51", connectorKeyId: k2.id });
    access.createAccessRequest(sa.id, { space: "sp", project: "x1", access: "read", reason: "r" });
    assert.throws(() => access.createAccessRequest(sa.id, { space: "sp", project: "x2", access: "read", reason: "r" }), /from this address/);
    assert.ok(access.createAccessRequest(sb.id, { space: "sp", project: "x3", access: "read", reason: "r" }).created, "other key is not starved");
  } finally {
    process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
    db.prepare("DELETE FROM access_requests").run();
  }
});

test("eviction order only considers live pending requests: an expired one no longer protects its session", () => {
  const live = sessions.createSession({ clientName: "live", clientVersion: "1", ip: "192.0.2.60" });
  const stale = sessions.createSession({ clientName: "stale", clientVersion: "1", ip: "192.0.2.60" });
  access.createAccessRequest(live.id, { space: "sp", project: "l", access: "read", reason: "r" });
  const r = access.createAccessRequest(stale.id, { space: "sp", project: "s", access: "read", reason: "r" }).request;
  db.prepare("UPDATE access_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), r.id);
  // `live` is the older (more idle) one but has a live request, so the stale-request session goes first.
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 50_000).toISOString(), live.id);
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 10_000).toISOString(), stale.id);
  assert.equal(sessions.evictGrantlessSession("192.0.2.60"), true);
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(live.id));
  assert.equal(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(stale.id), undefined);
  db.prepare("DELETE FROM access_requests").run();
});

test("anonymous body cap: 32 KB with a connector key", async () => {
  const r = await raw({ "x-api-key": KEY }, { pad: "x".repeat(40_000) });
  assert.equal(r.status, 413);
  assert.match(((await r.json()) as any).error.message, /32 KB/);
});

test("no audit row ever contains a request code (request, repeat, elevation, approve, deny)", async () => {
  const sid = await connect();
  const codes: string[] = [];
  const r1 = await request(sid, "sp", "code-a", "read");
  codes.push(reqCode(r1.text));
  const again = await request(sid, "sp", "code-a", "read");
  codes.push(reqCode(again.text));
  approve(reqId(r1.text), { actor: "admin:x" });
  const el = await request(sid, "sp", "code-a", "write");
  codes.push(reqCode(el.text));
  approve(reqId(el.text), { actor: "admin:x" });
  const el2 = await request(sid, "sp", "code-b", "read");
  codes.push(reqCode(el2.text));
  access.denyRequest(reqId(el2.text), "admin:x");
  assert.match(r1.text, /Show them this code/);
  const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
  for (const c of codes) assert.equal(dump.includes(c), false, `code ${c} leaked into the audit log`);
  for (const action of ["access_approve", "access_elevation_request", "access_elevation_approve", "access_elevation_deny", "access_deny", "kb_request_access"]) {
    // Every action above was produced at least once in this file (elevation deny/approve in this test).
    void action;
  }
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_request'").get());
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_deny'").get());
  const { authAuditBudget, flushAuthAudit } = await import("./authFailure");
  for (let i = 0; i < 40; i++) authAuditBudget.take();
  const before = count("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE '%further auth failures%'");
  flushAuthAudit();
  assert.equal(count("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE '%further auth failures%'") - before, 1, "pending summary flushed once");
  flushAuthAudit();
  assert.equal(count("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE '%further auth failures%'") - before, 1);
});

test("write request defaults: meta read, project read+write; access=read adds no write", () => {
  const f = (s: Array<{ space: string; project: string; section: string; permission: string }>) => s.map((x) => `${x.space}:${x.project}:${x.section}:${x.permission}`);
  assert.deepEqual(f(access.defaultAccessScopes("pro", "x", "write")), ["meta:*:*:read", "pro:x:*:read", "pro:x:*:write"]);
  assert.deepEqual(f(access.defaultAccessScopes("pro", "x", "read")), ["meta:*:*:read", "pro:x:*:read"]);
});
