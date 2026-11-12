import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, makeTempDb, makeTempVault } from "../test-support/fixtures";

makeTempDb();
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";
const { vault } = makeTempVault();

type Web = typeof import("./web");
let web: Web;
let db: typeof import("../db").db;
let access: typeof import("../access");
let sessions: typeof import("../auth/sessions");
let server: http.Server;
let port: number;
let adminSrv: http.Server;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function request(p: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: p, method, path, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const SECRET = "test-secret";
const PROXY_SECRET = "p".repeat(40);
const ADMIN = { "remote-user": "alice", "remote-groups": "admins", "x-sb-admin-proxy": PROXY_SECRET, cookie: "authelia_session=s1" };
const get = (path: string) => request(port, "GET", path, ADMIN);

async function nonceFor(action: string): Promise<string> {
  const r = await get("/access");
  const m = new RegExp(`action="${action}"[^>]*>\\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"`).exec(r.body);
  assert.ok(m, `form ${action}`);
  return m[1];
}
async function post(path: string, fields: Record<string, string>, over: { csrf?: string | null; origin?: string | null; nonce?: string | null } = {}): Promise<Res> {
  const f = { ...fields };
  const t = over.csrf === undefined ? web.csrfToken(SECRET, "alice", "s1") : over.csrf;
  if (t !== null) f.csrf = t;
  const n = over.nonce === undefined ? await nonceFor(path) : over.nonce;
  if (n !== null) f.nonce = n;
  const headers: Record<string, string> = { ...ADMIN, "content-type": "application/x-www-form-urlencoded" };
  const origin = over.origin === undefined ? `http://127.0.0.1:${port}` : over.origin;
  if (origin !== null) headers.origin = origin;
  return request(port, "POST", path, headers, new URLSearchParams(f).toString());
}
async function follow(r: Res): Promise<Res> {
  assert.equal(r.status, 303, r.body);
  return get(String(r.headers.location));
}

// One pending card (from its opening div to the next card or the end of the pending list).
function cardOf(body: string, id: string): string {
  const start = body.lastIndexOf('<div class="card stack">', body.indexOf(id));
  const next = body.indexOf('<div class="card stack">', start + 10);
  return body.slice(start, next === -1 ? start + 4000 : next);
}

function newSession(client = "Claude Code") {
  const { sid, id } = sessions.createSession({ clientName: client, clientVersion: "1.2.3", ip: "203.0.113.7" });
  return { sid, id };
}
const ask = (sessionId: string, space: string, project: string, access_ = "write", extra: Record<string, unknown> = {}) =>
  access.createAccessRequest(sessionId, { space, project, access: access_, reason: "because <b>reason</b>", ...extra }).request;

before(async () => {
  web = await import("./web");
  db = (await import("../db")).db;
  access = await import("../access");
  sessions = await import("../auth/sessions");
  const { createTrustedProxy } = await import("../server");
  const app = web.createWebAdminApp({ vaultRoot: vault, trustedProxy: createTrustedProxy("127.0.0.1"), secret: SECRET, proxySecret: PROXY_SECRET });
  server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = (server.address() as AddressInfo).port;
  const { createAdminApp, listenAdmin } = await import("../admin");
  adminSrv = await listenAdmin(createAdminApp(vault), 0);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => adminSrv.close(r));
  cleanup();
});

test("access page: pending request with client, IP, project, reason (escaped), code, default scopes; dashboard badge", async () => {
  const s = newSession();
  const r = ask(s.id, "pro", "alpha", "write");
  const page = await get("/access");
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, new RegExp(r.code), "the code is never displayed on the card");
  assert.match(page.body, new RegExp(r.id));
  assert.match(page.body, /Claude Code/);
  assert.match(page.body, /203\.0\.113\.7/);
  assert.match(page.body, /<code>pro:alpha:\*:write<\/code> <span class="badge err">write<\/span>/);
  assert.match(page.body, /because &lt;b&gt;reason&lt;\/b&gt;/);
  assert.doesNotMatch(page.body, /<b>reason/);
  assert.match(page.body, /meta:\*:\*:read\npro:alpha:\*:read\npro:alpha:\*:write/);
  assert.match(page.body, /<a href="\/access"[^>]*>Access<\/a>/);
  assert.doesNotMatch(page.body, /\sstyle\s*=|\son[a-z]+\s*=/i);
  const dash = await get("/");
  assert.match(dash.body, /<div class="n">1<\/div><div class="l">pending access requests/);
});

test("approve via the page with editable scopes, then active sessions + revoke; CSRF and nonce enforced", async () => {
  const s = newSession("Claude Desktop");
  const r = ask(s.id, "pro", "beta", "read");
  const path = `/access/${r.id}/approve`;
  const scopes = "meta:*:*:read\npro:beta:notes:read";
  const code = r.code;
  assert.equal((await post(path, { scopes, code }, { csrf: null })).status, 403);
  assert.equal((await post(path, { scopes, code }, { csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post(path, { scopes, code }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(path, { scopes, code }, { nonce: null })).status, 409);
  assert.equal(sessions.listGrants(s.id).length, 0, "nothing granted by refused posts");

  // The typed code is mandatory and compared server-side.
  assert.match((await follow(await post(path, { scopes }))).body, /Type the request code/);
  assert.match((await follow(await post(path, { scopes, code: "AAAAAA" }))).body, /Type the request code/);
  assert.equal(sessions.listGrants(s.id).length, 0);

  // Wildcard beyond the default needs the confirmation box.
  const wild = await follow(await post(path, { scopes: "pro:*:*:write", code }));
  assert.match(wild.body, /Wildcard scopes grant broad access/);
  assert.equal(sessions.listGrants(s.id).length, 0);

  const ok = await follow(await post(path, { scopes, code }));
  assert.match(ok.body, /Approved pro\/beta as session-claude-desktop-pro-beta/);
  assert.deepEqual(sessions.listGrants(s.id).flatMap((g) => g.scopes.map((x) => `${x.section}:${x.permission}`)), ["*:read", "notes:read"]);
  const row = db.prepare("SELECT action, token_name FROM audit_log WHERE action = 'access_approve' ORDER BY id DESC").get() as any;
  assert.equal(row.token_name, "admin:alice");

  // Replay with a spent nonce is refused.
  assert.equal((await post(path, { scopes, code }, { nonce: "a".repeat(32) })).status, 409);

  const page = await get("/access");
  assert.match(page.body, /session-claude-desktop-pro-beta/);
  const revokePath = `/access/sessions/${s.id}/revoke`;
  const done = await follow(await post(revokePath, {}));
  assert.match(done.body, /Session revoked/);
  assert.equal(sessions.listGrants(s.id).length, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_revoke' AND token_name = 'admin:alice'").get());
  assert.match((await follow(await post(`/access/sessions/${s.id}/revoke`, {}, { nonce: await nonceForAny() }))).body, /not found or already revoked/);
});

// Any valid nonce (the revoke form of the page may be gone once the session is).
async function nonceForAny(): Promise<string> {
  const s = newSession();
  ask(s.id, "pro", "nonce-donor");
  const r = await get("/access");
  const m = /action="\/access\/[0-9a-f-]+\/deny"[^>]*>\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"/.exec(r.body);
  assert.ok(m);
  return m[1];
}

test("deny via the page leaves the session without access; unknown ids are rejected", async () => {
  const s = newSession();
  const r = ask(s.id, "pro", "gamma");
  const done = await follow(await post(`/access/${r.id}/deny`, {}));
  assert.match(done.body, /Denied pro\/gamma/);
  assert.equal(access.accessStatus(s.id, r.id)?.status, "denied");
  assert.equal((await get("/access/not-a-uuid/x")).status, 404);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_deny' AND token_name = 'admin:alice'").get());
});

test("page shows the session's CURRENT grants next to the requested ones and labels an elevation", async () => {
  const s = newSession("Claude Code");
  const first = ask(s.id, "pro", "delta", "read");
  assert.equal(first.elevation, 0);
  let page = await get("/access");
  assert.doesNotMatch(cardOf(page.body, first.id), /elevation/);
  access.approveRequest(first.id, { actor: "admin:alice", code: first.code });
  const up = ask(s.id, "pro", "delta", "write");
  assert.equal(up.elevation, 1);
  page = await get("/access");
  const card = cardOf(page.body, up.id);
  assert.match(card, /<span class="badge err">elevation<\/span>/);
  assert.match(card, /Current grants of this session:[\s\S]*session-claude-code-pro-delta[\s\S]*<code>pro:delta:\*:read<\/code>/);
  assert.match(card, /Asks for:[\s\S]*<code>pro:delta:\*:write<\/code>/);
  // Deny leaves the existing grant.
  await follow(await post(`/access/${up.id}/deny`, {}));
  assert.equal(sessions.listGrants(s.id).length, 1);
});

test("tokens page marks session grants; revoking one there cuts the session", async () => {
  const s = newSession();
  { const q = ask(s.id, "pro", "epsilon"); access.approveRequest(q.id, { actor: "t", code: q.code }); }
  const hidden = await get("/tokens");
  assert.doesNotMatch(hidden.body, /session-claude-code-pro-epsilon/, "session grants are hidden by default");
  assert.match(hidden.body, /href="\/tokens\?sessions=1"/);
  const page = await get("/tokens?sessions=1");
  assert.match(page.body, /session-claude-code-pro-epsilon[\s\S]*?<span class="badge">session<\/span>/);
  const g = sessions.listGrants(s.id)[0];
  assert.ok(page.body.includes(`/tokens/${g.tokenId}/revoke`));
  assert.equal((await import("../auth/tokens")).revokeToken(g.tokenId), true);
  assert.equal(sessions.listGrants(s.id).length, 0);
});

// ---- CLI over the loopback admin listener ----

test("CLI: access list / approve (code or id, scope override, wildcard confirm) / deny", async () => {
  const { run } = await import("../cli/access");
  const base = `http://127.0.0.1:${(adminSrv.address() as AddressInfo).port}`;
  const s = newSession("Claude Code");
  const r1 = ask(s.id, "pro", "cli-a", "write");
  const r2 = ask(s.id, "pro", "cli-b", "read");
  const r3 = ask(s.id, "pro", "cli-c", "read");

  const hidden = await run(["list"], base);
  assert.ok(!hidden.includes(r1.code) && !hidden.includes("code="), "codes hidden by default");
  const list = await run(["list", "--codes"], base);
  assert.match(list, new RegExp(`${r1.id}  code=${r1.code}  client=Claude Code 1.2.3  ip=203\\.0\\.113\\.7.*scopes=\\[meta:\\*:\\*:read, pro:cli-a:\\*:read, pro:cli-a:\\*:write\\]`));
  assert.match(list, /Active sessions:|No active sessions/);

  // by code, default scopes
  const a = await run(["approve", r1.code.toLowerCase()], base);
  assert.match(a, /Approved pro\/cli-a as session-claude-code-pro-cli-a: meta:\*:\*:read, pro:cli-a:\*:read, pro:cli-a:\*:write/);
  // by id, explicit scope; wildcard needs --allow-wildcard
  await assert.rejects(run(["approve", r2.id, "--scope", "pro:*:*:read"], base), /Type the request code/);
  await assert.rejects(run(["approve", r2.id, "--code", r2.code, "--scope", "pro:*:*:read"], base), /Wildcard[\s\S]*pro:\*:\*:read/);
  assert.equal(sessions.listGrants(s.id).length, 1);
  assert.match(await run(["approve", r2.id, "--code", r2.code, "--scope", "pro:*:*:read", "--allow-wildcard"], base), /Approved pro\/cli-b/);
  await assert.rejects(run(["approve", r2.id], base), /already approved/);
  await assert.rejects(run(["approve", r3.id, "--code", r3.code, "--scope", "garbage"], base), /invalid scope/);
  assert.match(await run(["deny", r3.code], base), /Denied access request for pro\/cli-c/);
  await assert.rejects(run(["deny", r3.code], base), /not found/);
  await assert.rejects(run(["approve", "bad ref!"], base), /invalid request id or code|usage/i);
  await assert.rejects(run(["frobnicate"], base), /usage/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_approve' AND token_name = 'admin-cli'").get());
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'access_deny' AND token_name = 'admin-cli'").get());
  assert.match(await run(["list"], base), /Active sessions:/);
});

// ---- scopes headline, elevation, expiry columns ----

test("card lists each requested scope with writes highlighted, warns when scopes exceed the stated request; sessions show created and expiry", async () => {
  const s = newSession("Claude Code");
  const r = ask(s.id, "pro", "zeta", "read", { scopes: ["pro:zeta:notes:read", "pro:other:notes:write"] });
  const page = await get("/access");
  const card = cardOf(page.body, r.id);
  assert.match(card, /<code>pro:zeta:notes:read<\/code>/);
  assert.match(card, /<code>pro:other:notes:write<\/code> <span class="badge err">write<\/span>/);
  assert.match(card, /scopes exceed the stated request/);
  assert.ok(!card.slice(0, 1500).includes(r.code), "code not shown");
  assert.match(card, /Request code/);
  const t = ask(s.id, "pro", "eta", "read", { scopes: ["pro:eta:notes:read"] });
  const page2 = await get("/access");
  assert.doesNotMatch(cardOf(page2.body, t.id), /exceed/);
  access.approveRequest(t.id, { actor: "t", code: t.code });
  const sessionsPage = (await get("/access")).body;
  assert.match(sessionsPage, /<th>Created<\/th><th>Last seen<\/th><th>Expires<\/th>/);
});

// ---- connector keys ----

test("connector keys: create (one-time page with header + Copy), list, reveal (audited, no-store), revoke ends sessions", async () => {
  const keys = await import("../auth/connectorKeys");
  assert.match((await get("/access")).body, /No keys: token-less access is disabled/);
  const created = await follow(await post("/access/keys", { name: "claude-ai" }));
  assert.match(created.body, /X-SB-Connector-Key/);
  const key = /<textarea id="ckey-value"[^>]*>(sbk_[A-Za-z0-9_-]+)<\/textarea>/.exec(created.body)?.[1];
  assert.ok(key, "key shown on the creation page");
  assert.match(created.body, /data-copy="ckey-value"/);
  assert.match(created.body, /--header &quot;X-SB-Connector-Key: sbk_/);
  assert.equal(keys.checkConnectorKey(key)?.name, "claude-ai");
  // One-time flash: a reload does not show it again.
  const again = await get(`/access/keys/created/${"0".repeat(32)}`);
  assert.equal(again.status, 404);

  let page = (await get("/access")).body;
  assert.doesNotMatch(page, new RegExp(key as string), "the list never shows the value");
  assert.match(page, /claude-ai/);
  const id = db.prepare("SELECT id FROM connector_keys WHERE name = 'claude-ai'").get() as { id: string };

  // Reveal: POST with CSRF + nonce, audited without the value, never cached.
  const revealPath = `/access/keys/${id.id}/reveal`;
  assert.equal((await post(revealPath, {}, { csrf: null })).status, 403);
  const rev = await post(revealPath, {});
  assert.equal(rev.status, 200);
  assert.match(String(rev.headers["cache-control"]), /no-store/);
  assert.ok(rev.body.includes(key as string));
  assert.match(rev.body, /X-SB-Connector-Key/);
  const audit = db.prepare("SELECT action, token_name, result, detail FROM audit_log WHERE action = 'connector_key_reveal' ORDER BY id DESC").get() as any;
  assert.deepEqual([audit.token_name, audit.result], ["admin:alice", "ok"]);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM audit_log").all()).includes(key as string), false, "audit never holds the value");

  // Undecryptable (made under another secret): clear message, still authenticates.
  const foreign = keys.createConnectorKey("foreign", "another-secret");
  page = (await get("/access")).body;
  const m = /action="\/access\/keys\/([0-9a-f-]+)\/reveal"/g;
  assert.ok(page.match(m));
  const bad = await follow(await post(`/access/keys/${foreign.id}/reveal`, {}));
  assert.match(bad.body, /Cannot decrypt this key/);
  assert.ok(keys.checkConnectorKey(foreign.key));
  assert.equal((db.prepare("SELECT result FROM audit_log WHERE action = 'connector_key_reveal' ORDER BY id DESC").get() as any).result, "error");

  // Revoke: its sessions and their grants end now.
  const s = sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.9", connectorKeyId: id.id });
  access.approveRequest(ask(s.id, "pro", "kappa").id, { actor: "t", code: (db.prepare("SELECT code FROM access_requests WHERE session_id = ?").get(s.id) as any).code });
  assert.match((await get("/access")).body, /<th>Key<\/th>/);
  const done = await follow(await post(`/access/keys/${id.id}/revoke`, {}));
  assert.match(done.body, /Key revoked, 1 session\(s\) ended/);
  assert.equal(keys.checkConnectorKey(key), null);
  assert.equal(sessions.listGrants(s.id).length, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'admin_connector_key_revoke' AND token_name = 'admin:alice'").get());
});

test("connector key CLI: create, show (audited), list, revoke", async () => {
  const { run } = await import("../cli/connectorKey");
  process.env.ADMIN_WEB_SECRET = "cli-secret";
  try {
    assert.throws(() => run(["create"]), /name must be/);
    const out = run(["create", "--name", "cli-key"]);
    const key = /X-SB-Connector-Key: (sbk_[A-Za-z0-9_-]+)/.exec(out)?.[1];
    assert.ok(key);
    assert.match(out, /claude mcp add --scope user --transport http second-brain .* --header "X-SB-Connector-Key: sbk_/);
    assert.ok(run(["show", "--name", "cli-key"]).includes(key as string));
    const a = db.prepare("SELECT token_name, result, detail FROM audit_log WHERE action = 'connector_key_reveal' ORDER BY id DESC").get() as any;
    assert.deepEqual([a.token_name, a.result], ["cli", "ok"]);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM audit_log").all()).includes(key as string), false);
    assert.throws(() => run(["show", "--name", "nope"]), /no such active connector key/);
    const twin1 = run(["create", "--name", "twin"]);
    run(["create", "--name", "twin"]);
    assert.throws(() => run(["show", "--name", "twin"]), /ambiguous name, use --id/);
    const twinId = /id:\s+([0-9a-f-]+)/.exec(twin1)?.[1] as string;
    assert.match(run(["show", "--id", twinId]), /sbk_/);
    process.env.ADMIN_WEB_SECRET = "changed";
    assert.throws(() => run(["show", "--name", "cli-key"]), /cannot decrypt/);
    assert.match(run(["list"]), /name=cli-key/);
    const id = /id=([0-9a-f-]+)  name=cli-key/.exec(run(["list"]))?.[1] as string;
    assert.match(run(["revoke", "--id", id]), /revoked, 0 session/);
    assert.throws(() => run(["revoke", "--id", id]), /not found/);
    assert.throws(() => run(["revoke"]), /--id is required/);
    assert.throws(() => run(["frobnicate"]), /usage/);
  } finally {
    delete process.env.ADMIN_WEB_SECRET;
  }
});
