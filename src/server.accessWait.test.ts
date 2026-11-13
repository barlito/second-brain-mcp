import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault, sleep } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
process.env.ACCESS_MAX_PENDING_PER_SESSION = "1000";
process.env.SESSION_BASELINE_SCOPES = "none";

type Db = typeof import("./db").db;
type App = Awaited<ReturnType<typeof listen>>;
let db: Db;
let app: App;
let eventsApp: App;
let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");
let wait: typeof import("./accessWait");
let KEY: string;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1.0" } },
};
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function rpc(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${app.baseUrl}/mcp`, { method: "POST", headers: { ...HEADERS, "x-api-key": KEY, ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  const data = /^data: (.*)$/m.exec(text);
  return { headers: res.headers, json: JSON.parse(data ? data[1] : text) };
}

const connect = async (): Promise<string> => (await rpc(INIT)).headers.get("mcp-session-id") as string;
let nextId = 10;
async function call(sid: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ isError: boolean; text: string }> {
  const r = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid }, signal);
  return { isError: r.json.result?.isError === true, text: r.json.result?.content?.[0]?.text ?? JSON.stringify(r.json) };
}
const requestAccess = async (sid: string, project: string) => {
  const r = await call(sid, "kb_request_access", { space: "sp", project, access: "read", reason: "r" });
  return { text: r.text, id: /Request id: ([0-9a-f-]{36})/.exec(r.text)![1] };
};
const sessionRowId = (sid: string): string => (db.prepare("SELECT id FROM sessions WHERE sid_hash = ?").get(sessions.hashSid(sid)) as { id: string }).id;
const approve = (id: string) => access.approveRequest(id, { code: (db.prepare("SELECT code FROM access_requests WHERE id = ?").get(id) as { code: string }).code, actor: "admin:test" });
const expireIn = (id: string, ms: number) => db.prepare("UPDATE access_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() + ms).toISOString(), id);
const stillWaiting = async (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => false), sleep(60).then(() => true)]);
const newSession = () => sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.7" }).id;
const ask = (sessionId: string, project = "p") => access.createAccessRequest(sessionId, { space: "sp", project, access: "read", reason: "r" }).request.id;

before(async () => {
  ({ db } = await import("./db"));
  access = await import("./access");
  sessions = await import("./auth/sessions");
  wait = await import("./accessWait");
  const keys = await import("./auth/connectorKeys");
  KEY = keys.createConnectorKey("wait-key", "test-admin-secret").key;
  const { createApp, AuthFailureLimiter } = await import("./server");
  const { anonLimits } = await import("./rateLimit");
  const anon = { ...anonLimits(), initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, sessionsPerIp: 1000, ipCallsPerMin: 100000, sessionCallsPerMin: 100000 };
  app = await listen(createApp({ vaultRoot: vault, authLimiter: new AuthFailureLimiter(100_000), anonLimits: anon }));
  eventsApp = await listen(createApp({ vaultRoot: vault, anonLimits: anon, accessEvents: { heartbeatMs: 40, streamsPerMin: 1000 } }));
});
after(async () => {
  await app.close();
  await eventsApp.close();
  cleanup();
});

// ---- kb_access_status wait_seconds ----

test("without wait_seconds a pending request answers at once (unchanged)", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-none");
  const t = Date.now();
  assert.match((await call(sid, "kb_access_status", { request_id: id })).text, /^pending/);
  assert.match((await call(sid, "kb_access_status", { request_id: id, wait_seconds: 0 })).text, /^pending/);
  assert.ok(Date.now() - t < 800);
});

test("wait returns as soon as the user approves", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-approve");
  const pending = call(sid, "kb_access_status", { request_id: id, wait_seconds: 20 });
  await sleep(150);
  const t = Date.now();
  approve(id);
  const r = await pending;
  assert.match(r.text, /^approved/);
  assert.match(r.text, /sp:w-approve:\*:read/);
  assert.ok(Date.now() - t < 1500);
});

test("wait returns as soon as the user denies", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-deny");
  const pending = call(sid, "kb_access_status", { request_id: id, wait_seconds: 20 });
  await sleep(150);
  access.denyRequest(id, "admin:test");
  assert.match((await pending).text, /^denied/);
});

test("wait times out and answers pending", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-timeout");
  const t = Date.now();
  assert.match((await call(sid, "kb_access_status", { request_id: id, wait_seconds: 1 })).text, /^pending/);
  assert.ok(Date.now() - t >= 900);
});

test("expiry during a wait is detected", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-expire");
  expireIn(id, 400);
  const t = Date.now();
  assert.match((await call(sid, "kb_access_status", { request_id: id, wait_seconds: 20 })).text, /^expired/);
  assert.ok(Date.now() - t < 3000);
});

test("an already decided request answers at once even with wait_seconds", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-done");
  approve(id);
  const t = Date.now();
  assert.match((await call(sid, "kb_access_status", { request_id: id, wait_seconds: 50 })).text, /^approved/);
  assert.ok(Date.now() - t < 800);
});

test("wait_seconds is bounded to 0..50 integers", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-bounds");
  for (const bad of [-1, 51, 1.5, "10"]) {
    const r = await call(sid, "kb_access_status", { request_id: id, wait_seconds: bad });
    assert.equal(r.isError, true, String(bad));
    assert.match(r.text, /wait_seconds/);
  }
  for (const ok of [0, 1]) assert.equal((await call(sid, "kb_access_status", { request_id: id, wait_seconds: ok })).isError, false);
});

test("a client that goes away frees its wait slot", async () => {
  const sid = await connect();
  const { id } = await requestAccess(sid, "w-abort");
  const ctl = new AbortController();
  const gone = call(sid, "kb_access_status", { request_id: id, wait_seconds: 50 }, ctl.signal).catch(() => undefined);
  await sleep(150);
  ctl.abort();
  await gone;
  await sleep(150);
  const session = sessionRowId(sid);
  const holders = Array.from({ length: wait.MAX_WAITS_PER_SESSION }, () => new AbortController());
  const waits = holders.map((h) => wait.waitForDecision(session, id, 50, h.signal));
  for (const w of waits) assert.equal(await stillWaiting(w), true, "every slot was free again");
  holders.forEach((h) => h.abort());
  await Promise.all(waits);
});

test("waits are capped per session and globally; over the cap answers at once", async () => {
  const holders: AbortController[] = [];
  const hold = (session: string, id: string): Promise<void> => {
    const h = new AbortController();
    holders.push(h);
    return wait.waitForDecision(session, id, 50, h.signal);
  };
  const s = newSession();
  const id = ask(s, "cap-1");
  const held = Array.from({ length: wait.MAX_WAITS_PER_SESSION }, () => hold(s, id));
  assert.equal(await stillWaiting(hold(s, id)), false, "per-session cap");
  const others = Array.from({ length: wait.MAX_WAITS_TOTAL - wait.MAX_WAITS_PER_SESSION }, (_, i) => {
    const o = newSession();
    return hold(o, ask(o, `cap-o${i}`));
  });
  const extra = newSession();
  assert.equal(await stillWaiting(hold(extra, ask(extra, "cap-x"))), false, "global cap");
  holders.forEach((h) => h.abort());
  await Promise.all([...held, ...others]);
  assert.equal(await stillWaiting(hold(extra, ask(extra, "cap-y"))), true, "slots released");
  holders.forEach((h) => h.abort());
});

test("no watcher is left behind by many finished waits", async () => {
  const s = newSession();
  for (let i = 0; i < 30; i++) {
    const id = ask(s, `leak-${i}`);
    const ctl = new AbortController();
    const p = wait.waitForDecision(s, id, 50, ctl.signal);
    if (i % 2) access.denyRequest(id, "admin:test");
    else ctl.abort();
    await p;
  }
  const prepare = mock.method(db, "prepare");
  try {
    access.notifyAccessChange();
    assert.equal(prepare.mock.callCount(), 0, "no watcher still reads the DB on a change");
  } finally {
    prepare.mock.restore();
  }
  const id = ask(s, "leak-last");
  const holders = Array.from({ length: wait.MAX_WAITS_PER_SESSION }, () => new AbortController());
  const waits = holders.map((h) => wait.waitForDecision(s, id, 50, h.signal));
  for (const w of waits) assert.equal(await stillWaiting(w), true, "every slot was released");
  holders.forEach((h) => h.abort());
  await Promise.all(waits);
});

// ---- kb_request_access text ----

test("the success text carries the absolute events URL and the new wait rule", async () => {
  const sid = await connect();
  const r = await requestAccess(sid, "text-a");
  assert.ok(r.text.includes(`Events URL: https://second-brain.barlito.fr/access-requests/${r.id}/events`), r.text);
  assert.match(r.text, /curl -sN <events URL>/);
  assert.match(r.text, /wait_seconds=50/);
  process.env.PUBLIC_MCP_URL = "https://second-brain.local.barlito.fr/mcp";
  try {
    const l = await requestAccess(sid, "text-b");
    assert.ok(l.text.includes(`Events URL: https://second-brain.local.barlito.fr/access-requests/${l.id}/events`), l.text);
  } finally {
    delete process.env.PUBLIC_MCP_URL;
  }
});

// ---- GET /access-requests/:id/events ----

async function openStream(id: string, base = eventsApp.baseUrl) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/access-requests/${id}/events`, { signal: ctl.signal });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ended = false;
  // Reads until `until` matches the accumulated text, or the stream ends.
  const read = async (until: RegExp): Promise<string> => {
    while (!until.test(buf) && !ended && reader) {
      const { done, value } = await reader.read();
      if (done) ended = true;
      else buf += dec.decode(value);
    }
    return buf;
  };
  return { res, read, ctl, isEnded: () => ended };
}

test("events: initial status, then the change, then the stream closes", async () => {
  const s = newSession();
  const id = ask(s, "sse-a");
  const st = await openStream(id);
  assert.equal(st.res.status, 200);
  assert.match(st.res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.match(st.res.headers.get("cache-control") ?? "", /no-cache/);
  assert.equal(st.res.headers.get("x-accel-buffering"), "no");
  assert.match(await st.read(/data: pending\n\n/), /event: status\ndata: pending\n\n/);
  approve(id);
  const all = await st.read(/data: approved\n\n/);
  assert.match(all, /event: status\ndata: approved\n\n/);
  await st.read(/never/);
  assert.equal(st.isEnded(), true);
});

test("events: denied and already-terminal requests send their status and close", async () => {
  const s = newSession();
  const a = ask(s, "sse-deny");
  const st = await openStream(a);
  await st.read(/data: pending/);
  access.denyRequest(a, "admin:test");
  assert.match(await st.read(/never/), /data: denied\n\n/);
  const again = await openStream(a);
  assert.match(await again.read(/never/), /data: denied\n\n/);
  const e = ask(s, "sse-expired");
  expireIn(e, -1000);
  assert.match(await (await openStream(e)).read(/never/), /data: expired\n\n/);
});

test("events: expiry while connected is pushed", async () => {
  const s = newSession();
  const id = ask(s, "sse-expiring");
  expireIn(id, 300);
  const st = await openStream(id);
  assert.match(await st.read(/never/), /data: pending\n\n[\s\S]*data: expired\n\n/);
});

test("events: heartbeat comments keep an idle stream alive", async () => {
  const s = newSession();
  const st = await openStream(ask(s, "sse-beat"));
  assert.match(await st.read(/: ping\n\n/), /: ping\n\n/);
  st.ctl.abort();
});

test("events: the payload is the status word and nothing else", async () => {
  const s = newSession();
  const id = ask(s, "sse-leak");
  const st = await openStream(id);
  await st.read(/data: pending/);
  approve(id);
  const body = await st.read(/never/);
  const code = (db.prepare("SELECT code FROM access_requests WHERE id = ?").get(id) as { code: string }).code;
  const lines = body.split("\n").filter((l) => l && !l.startsWith(": ") && !l.startsWith("retry:"));
  assert.deepEqual(lines, ["event: status", "data: pending", "event: status", "data: approved"]);
  for (const secret of [code, s, "sse-leak", "meta", "read", "sp:"]) assert.equal(body.includes(secret), false, secret);
});

test("events: unknown and malformed ids get the same 404", async () => {
  const get = async (id: string) => {
    const r = await fetch(`${eventsApp.baseUrl}/access-requests/${id}/events`);
    return { status: r.status, body: await r.text(), type: r.headers.get("content-type") };
  };
  const unknown = await get("11111111-1111-4111-8111-111111111111");
  assert.equal(unknown.status, 404);
  for (const bad of ["nope", "..%2F..%2Fetc", "1".repeat(80), "11111111-1111-4111-8111-11111111111G"]) assert.deepEqual(await get(bad), unknown, bad);
});

test("events: a closed client frees its stream slot", async () => {
  const s = newSession();
  const id = ask(s, "sse-slots");
  const open = [];
  for (let i = 0; i < 10; i++) open.push(await openStream(id));
  for (const o of open) await o.read(/data: pending/);
  open.forEach((o) => o.ctl.abort());
  await sleep(100);
  const fresh = await openStream(id);
  assert.equal(fresh.res.status, 200);
  fresh.ctl.abort();
});

test("events: per-client rate limit and concurrent-stream cap answer 429", async () => {
  const { createApp } = await import("./server");
  const local = await listen(createApp({ vaultRoot: vault, accessEvents: { streamsPerMin: 1000 } }));
  const s = newSession();
  const id = ask(s, "sse-cap");
  const open = [];
  try {
    for (let i = 0; i < 10; i++) open.push(await openStream(id, local.baseUrl));
    assert.equal((await fetch(`${local.baseUrl}/access-requests/${id}/events`)).status, 429);
  } finally {
    open.forEach((o) => o.ctl.abort());
    await local.close();
  }
  const limited = await listen(createApp({ vaultRoot: vault, accessEvents: { streamsPerMin: 3 } }));
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${limited.baseUrl}/access-requests/${"2".repeat(8)}-2222-4222-8222-222222222222/events`)).status);
    assert.deepEqual(codes, [404, 404, 404, 429, 429]);
  } finally {
    await limited.close();
  }
});
