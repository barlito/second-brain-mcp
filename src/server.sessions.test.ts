import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type Db = typeof import("./db").db;
let db: Db;
let app: Awaited<ReturnType<typeof listen>>;
let tokens: typeof import("./auth/tokens");
let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");
let mkApp: (anon?: Partial<import("./rateLimit").AnonLimits>) => Promise<Awaited<ReturnType<typeof listen>>>;
let masterToken: string;

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
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
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
async function call(sid: string, name: string, args: Record<string, unknown>, base = app.baseUrl): Promise<{ isError: boolean; text: string; status: number }> {
  const r = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
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
  const { createApp } = await import("./server");
  mkApp = (anon = {}) => listen(createApp({ vaultRoot: vault, anonLimits: { initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, ...anon } }));
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
  assert.match(text, /kb_access_status/);
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
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
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
  const rows = db.prepare("SELECT result FROM audit_log WHERE token_name LIKE 'session-claude-code' AND action LIKE 'kb_%' AND detail = 'session has no grant'").all();
  assert.ok(rows.length >= calls.length);
});

test("request -> pending -> approve -> read; read grant cannot write; default scopes shape", async () => {
  const sid = await connect();
  const r = await request(sid, "sp", "proj-a", "read");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /ask the user to approve/i);
  assert.match(r.text, /kb_access_status/);
  const id = reqId(r.text);
  const code = reqCode(r.text);
  assert.match((await call(sid, "kb_access_status", { request_id: id })).text, /^pending/);
  // Still no access.
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" })).isError, true);

  const d = access.approveRequest(code, { actor: "admin:test" });
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
  access.approveRequest(a, { actor: "admin:test" });
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-b", section: "notes", note: "n1" })).isError, true, "second project not yet approved");
  access.approveRequest(b, { actor: "admin:test" });

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
  access.approveRequest(reqId((await request(sid, "sp", "proj-a", "write")).text), { actor: "admin:test" });
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
  access.approveRequest(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "admin:test" });
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
  assert.throws(() => access.approveRequest(id, { actor: "x" }), /already denied/);
  assert.equal((await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" })).isError, true);

  const id2 = reqId((await request(sid, "sp", "proj-b")).text);
  db.prepare("UPDATE access_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id2);
  assert.match((await call(sid, "kb_access_status", { request_id: id2 })).text, /^expired/);
  assert.throws(() => access.approveRequest(id2, { actor: "x" }), /expired|not found/);
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
    assert.equal(r.isError, true);
    assert.match(r.text, /Too many pending access requests\. Ask the user/);
  } finally {
    delete process.env.ACCESS_MAX_PENDING_TOTAL;
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
  const c = await mkApp({ maxSessions: sessions.countGrantlessSessions() + 1 });
  try {
    await connect(c.baseUrl);
    assert.equal((await rpc(c.baseUrl, INIT)).status, 503);
  } finally {
    await c.close();
  }
  db.prepare("DELETE FROM access_requests").run();
});

test("sliding expiry: 5 days with a grant, 1 hour without; use refreshes the window", async () => {
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
  access.approveRequest(reqId((await request(granted, "sp", "proj-a", "read")).text), { actor: "t" });
  setSeen(granted, 4 * day);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": granted })).status, 200, "4 days idle is fine with a grant");
  assert.ok(Date.now() - Date.parse(sidRow(granted)!.last_seen_at) < 5000, "last_seen refreshed (sliding)");
  setSeen(granted, 5 * day + 1000);
  assert.equal((await rpc(app.baseUrl, list, { "mcp-session-id": granted })).status, 404);
  // Expiry revoked the grant too.
  assert.equal((db.prepare("SELECT COUNT(*) c FROM tokens WHERE name = 'session-claude-code-sp-proj-a' AND revoked_at IS NULL AND session_id NOT IN (SELECT id FROM sessions)").get() as { c: number }).c, 0);

  assert.equal(sessions.sessionIdleMs({ SESSION_IDLE_DAYS: "2" } as NodeJS.ProcessEnv), 2 * day);
  assert.equal(sessions.sessionIdleMs({ SESSION_IDLE_DAYS: "nope" } as NodeJS.ProcessEnv), 5 * day);
  assert.equal(sessions.sessionIdleMs({} as NodeJS.ProcessEnv), 5 * day);
});

test("sessions survive a restart (DB-backed); pruning removes expired ones and revokes their grants", async () => {
  const sid = await connect();
  access.approveRequest(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "t" });
  // "Restart": a brand new app instance over the same database.
  const { createApp } = await import("./server");
  const fresh = await listen(createApp({ vaultRoot: vault, anonLimits: { initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000 } }));
  try {
    const r = await call(sid, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" }, fresh.baseUrl);
    assert.equal(r.isError, false, r.text);
  } finally {
    await fresh.close();
  }

  const stale = await connect();
  const grantedStale = await connect();
  access.approveRequest(reqId((await request(grantedStale, "sp", "proj-b", "read")).text), { actor: "t" });
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
  const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`));
  const client = new Client({ name: "sdk-client", version: "9.9" });
  await client.connect(transport);
  try {
    assert.match(String(transport.sessionId), /^[0-9a-f]{64}$/);
    assert.ok((await client.listTools()).tools.some((t) => t.name === "kb_request_access"));
    const r = (await client.callTool({ name: "kb_request_access", arguments: { space: "sp", project: "proj-a", access: "write", reason: "sdk test" } })) as any;
    assert.equal(r.isError ?? false, false);
    const id = reqId(r.content[0].text);
    access.approveRequest(id, { actor: "t" });
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
  access.approveRequest(id, { actor: "admin:alice" });
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

test("approve guards: unknown ref, wildcard confirmation, invalid scopes, concurrent decision", async () => {
  const sid = await connect();
  const id = reqId((await request(sid, "sp", "proj-a", "read")).text);
  assert.throws(() => access.approveRequest("ZZZZZZ", { actor: "t" }), /not found/);
  const wild = [{ space: "sp", project: "*", section: "*", permission: "write" as const }];
  assert.throws(() => access.approveRequest(id, { actor: "t", scopes: wild }), (e: any) => e.status === 422 && /Wildcard/.test(e.message) && e.lines.length === 1);
  assert.throws(() => access.approveRequest(id, { actor: "t", scopes: [{ space: "*", project: "x", section: "*", permission: "read" }] }), /invalid scope/);
  assert.throws(() => access.approveRequest(id, { actor: "t", scopes: [] }), /at least one scope/);
  // Nothing was granted by the failed attempts.
  assert.equal(listGrants(sid), 0);
  const d = access.approveRequest(id, { actor: "t", scopes: wild, allowWildcard: true });
  assert.equal(d.scopes.length, 1);
  assert.throws(() => access.approveRequest(id, { actor: "t" }), /already approved/);
  function listGrants(s: string): number {
    return sessions.listGrants(sidRow(s)!.id).length;
  }
});

test("elevation: an approved session asks for more; approve adds a grant (union), deny leaves existing grants untouched", async () => {
  const sid = await connect();
  access.approveRequest(reqId((await request(sid, "sp", "proj-a", "read")).text), { actor: "admin:test" });
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
  access.approveRequest(again, { actor: "admin:test" });
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_elevation_approve'").get());
  assert.equal((await call(sid, "kb_write", { ...aArgs, content: "x" })).isError, false);
  assert.equal(sessions.listGrants(sidRow(sid)!.id).length, 2);
  // Another project later in the same session.
  access.approveRequest(reqId((await request(sid, "sp", "proj-b", "read")).text), { actor: "admin:test" });
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
  // A wildcard request needs the admin's confirmation even though it is only a request.
  const w = await call(sid, "kb_request_access", { space: "sp", project: "proj-b", access: "read", reason: "r", scopes: ["sp:*:*:read"] });
  assert.equal(w.isError, false, w.text);
  assert.throws(() => access.approveRequest(reqId(w.text), { actor: "t" }), /Wildcard/);
  access.approveRequest(reqId(w.text), { actor: "t", allowWildcard: true });
  assert.throws(() => access.approveRequest(reqId(ok.text), { actor: "t" }), /Wildcard/, "section wildcard in an explicit list is confirmed too");
  access.approveRequest(reqId(ok.text), { actor: "t", allowWildcard: true });
  const granted = sessions.listGrants(sidRow(sid)!.id).flatMap((g) => g.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`));
  assert.ok(granted.includes("sp:proj-a:notes:read") && granted.includes("sp:*:*:read"));
  assert.ok(!granted.includes("meta:*:*:read"), "explicit list replaces the default shape");
});

test("instructions: access is on demand, not up front, and can be requested again later", async () => {
  const r = await rpc(app.baseUrl, INIT);
  const text: string = r.json.result.instructions;
  assert.match(text, /do NOT have to request access up front/);
  assert.match(text, /request again later in the same session/);
});

test("write request defaults: meta read, project read+write; access=read adds no write", () => {
  const f = (s: Array<{ space: string; project: string; section: string; permission: string }>) => s.map((x) => `${x.space}:${x.project}:${x.section}:${x.permission}`);
  assert.deepEqual(f(access.defaultAccessScopes("pro", "x", "write")), ["meta:*:*:read", "pro:x:*:read", "pro:x:*:write"]);
  assert.deepEqual(f(access.defaultAccessScopes("pro", "x", "read")), ["meta:*:*:read", "pro:x:*:read"]);
});
