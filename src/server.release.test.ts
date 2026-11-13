// kb_release_access: a token-less session gives back (part of) its own grants.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
// Default baseline (meta read) on purpose.
delete process.env.SESSION_BASELINE_SCOPES;

let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");
let masterToken: string;
let KEY: string;

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1.0" } } };

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": KEY, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = /^data: (.*)$/m.exec(text);
  let json: any;
  try {
    json = JSON.parse(data ? data[1] : text);
  } catch {}
  return { status: res.status, headers: res.headers, json };
}
let nextId = 10;
async function call(sid: string, name: string, args: Record<string, unknown>) {
  const r = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
  return { isError: r.json?.result?.isError === true, text: (r.json?.result?.content?.[0]?.text ?? JSON.stringify(r.json)) as string };
}
const connect = async (): Promise<string> => (await rpc(INIT)).headers.get("mcp-session-id") as string;
const rowOf = (sid: string) => db.prepare("SELECT id FROM sessions WHERE sid_hash = ?").get(sessions.hashSid(sid)) as { id: string };

// Requests then approves (admin side) with the given explicit scopes.
async function grant(sid: string, scopes: string[]): Promise<string> {
  const r = await call(sid, "kb_request_access", { scopes, reason: "work" });
  assert.equal(r.isError, false, r.text);
  const id = /Request id: ([0-9a-f-]{36})/.exec(r.text)![1];
  const code = (db.prepare("SELECT code FROM access_requests WHERE id = ?").get(id) as { code: string }).code;
  access.approveRequest(id, { actor: "admin:test", code });
  return id;
}
const tokenRows = (sid: string) => db.prepare("SELECT id, revoked_at FROM tokens WHERE session_id = ? AND kind = 'session' ORDER BY created_at, rowid").all(rowOf(sid).id) as Array<{ id: string; revoked_at: string | null }>;
const scopeCount = (tokenId: string) => (db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE token_id = ?").get(tokenId) as { n: number }).n;
const W = { space: "sp", project: "pa", section: "notes", note: "n", content: "x" };

before(async () => {
  ({ db } = await import("./db"));
  access = await import("./access");
  sessions = await import("./auth/sessions");
  const tokens = await import("./auth/tokens");
  const keys = await import("./auth/connectorKeys");
  const { createApp, AuthFailureLimiter } = await import("./server");
  const { anonLimits } = await import("./rateLimit");
  app = await listen(createApp({ vaultRoot: vault, authLimiter: new AuthFailureLimiter(100_000), anonLimits: { ...anonLimits(), initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, sessionsPerIp: 1000, ipCallsPerMin: 100000, sessionCallsPerMin: 100000 } }));
  KEY = keys.createConnectorKey("test-key", "test-admin-secret").key;
  masterToken = tokens.createToken("master", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kb_write", arguments: { space: "meta", project: "prefs", section: "notes", note: "style", content: "terse" } } }, { Authorization: `Bearer ${masterToken}` });
});
after(async () => {
  await app.close();
  cleanup();
});

test("release all: immediate effect, baseline stays, audit row, token revoked", async () => {
  const sid = await connect();
  await grant(sid, ["sp:pa:*:read", "sp:pa:*:write"]);
  assert.equal((await call(sid, "kb_write", W)).isError, false);
  const r = await call(sid, "kb_release_access", {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Released: sp:pa:\*:read, sp:pa:\*:write/);
  assert.match(r.text, /No grants remain/);
  assert.match(r.text, /Ask again with kb_request_access/);
  const w = await call(sid, "kb_write", W);
  assert.equal(w.isError, true);
  assert.match(w.text, /No access for this session/);
  assert.equal((await call(sid, "kb_read", { space: "meta", project: "prefs", section: "notes", note: "style" })).isError, false, "baseline read stays");
  assert.ok(tokenRows(sid).every((t) => t.revoked_at));
});

test("release subset: partial removal keeps the token, last scope revokes it, not-held reported", async () => {
  const sid = await connect();
  await grant(sid, ["sp:pa:*:read", "sp:pa:*:write"]);
  const [g] = tokenRows(sid);
  let r = await call(sid, "kb_release_access", { scopes: ["sp:pa:*:write", "sp:zz:*:read"] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Released: sp:pa:\*:write\./);
  assert.match(r.text, /Not held: sp:zz:\*:read\./);
  assert.match(r.text, /Still granted: sp:pa:\*:read/);
  assert.equal(scopeCount(g.id), 1);
  assert.equal(tokenRows(sid).find((t) => t.id === g.id)!.revoked_at, null);
  assert.equal((await call(sid, "kb_write", W)).isError, true);
  assert.doesNotMatch((await call(sid, "kb_read", { space: "sp", project: "pa", section: "notes", note: "n" })).text, /No access for this session|Permission denied/);
  r = await call(sid, "kb_release_access", { scopes: ["sp:pa:*:read"] });
  assert.match(r.text, /No grants remain/);
  assert.ok(tokenRows(sid).find((t) => t.id === g.id)!.revoked_at);
  assert.equal(sessions.listGrants(rowOf(sid).id).length, 0);
  // Nothing held at all: harmless.
  r = await call(sid, "kb_release_access", {});
  assert.equal(r.isError, false);
  assert.match(r.text, /nothing to release/);
});

test("exact match only: a wildcard scope does not expand", async () => {
  const sid = await connect();
  await grant(sid, ["sp:pa:*:read"]);
  const r = await call(sid, "kb_release_access", { scopes: ["sp:*:*:read"] });
  assert.match(r.text, /Not held: sp:\*:\*:read/);
  assert.equal(sessions.listGrants(rowOf(sid).id).length, 1);
});

test("another session's grants are untouched", async () => {
  const a = await connect();
  const b = await connect();
  await grant(a, ["sp:pa:*:write"]);
  await grant(b, ["sp:pa:*:write"]);
  const r = await call(a, "kb_release_access", { scopes: ["sp:pa:*:write"] });
  assert.match(r.text, /Released/);
  assert.equal(sessions.listGrants(rowOf(b).id).length, 1);
  assert.equal(sessions.listGrants(rowOf(b).id)[0].scopes.length, 1);
  assert.equal((await call(b, "kb_write", W)).isError, false);
  await call(a, "kb_release_access", {});
  assert.equal((await call(b, "kb_write", W)).isError, false);
});

test("Bearer tokens are refused and keep their access", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "kb_release_access", arguments: {} } }, { Authorization: `Bearer ${masterToken}` });
  assert.equal(r.json.result.isError, true);
  assert.match(r.json.result.content[0].text, /only for sessions connected without a token/);
  assert.equal((db.prepare("SELECT revoked_at FROM tokens WHERE name = 'master'").get() as any).revoked_at, null);
});

test("invalid scopes are refused; audit rows for release", async () => {
  const sid = await connect();
  await grant(sid, ["sp:pa:*:read"]);
  assert.equal((await call(sid, "kb_release_access", { scopes: ["nope"] })).isError, true);
  assert.equal((await call(sid, "kb_release_access", { scopes: [] })).isError, true);
  assert.equal((await call(sid, "kb_release_access", { scopes: Array(21).fill("sp:pa:*:read") })).isError, true);
  assert.equal(sessions.listGrants(rowOf(sid).id).length, 1);
  await call(sid, "kb_release_access", { scopes: ["sp:pa:*:read"] });
  const rows = db.prepare("SELECT result, detail FROM audit_log WHERE action = 'kb_release_access'").all() as any[];
  assert.ok(rows.some((x) => x.result === "ok" && /released 1: sp:pa:\*:read/.test(x.detail)), JSON.stringify(rows));
});

test("a session without grants falls back to the no-grant idle expiry", async () => {
  const sid = await connect();
  await grant(sid, ["sp:pa:*:read"]);
  await call(sid, "kb_release_access", {});
  const id = rowOf(sid).id;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 3_600_000).toISOString(), id);
  assert.equal(sessions.lookupSession(sid), null);
});

test("kb_access_status approved output ends with the release hint", async () => {
  const sid = await connect();
  const id = await grant(sid, ["sp:pa:*:read"]);
  const st = await call(sid, "kb_access_status", { request_id: id });
  assert.match(st.text, /Keep it for the whole conversation.*kb_release_access only when the user says the work is done.*expire on their own\.$/);
});
