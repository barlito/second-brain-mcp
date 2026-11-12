import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault, stripFm } from "../test-support/fixtures";
import { serializeProposal } from "../inbox";

makeTempDb();
const { vault } = makeTempVault();

type Web = typeof import("./web");
let web: Web;
let db: typeof import("../db").db;
let tokens: typeof import("../auth/tokens");
let server: http.Server;
let port: number;
let proxyOnly: http.Server;
let proxyPort: number;
let drain: () => Promise<void>;

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
const SESSION = "session-one";
const ADMIN = {
  "remote-user": "barlito",
  "remote-groups": "admins,dev",
  "remote-name": "Barlito",
  "x-sb-admin-proxy": PROXY_SECRET,
  cookie: `authelia_session=${SESSION}`,
};
const csrf = (user = "barlito", session = SESSION): string => web.csrfToken(SECRET, user, session);

const get = (path: string, headers: Record<string, string> = ADMIN) => request(port, "GET", path, headers);
// One-time nonce of the form posting to `action`, taken from the page that renders it.
async function nonceFor(action: string): Promise<string> {
  const page = action.startsWith("/inbox/") ? action.replace(/\/(accept|reject)$/, "") : "/tokens";
  const r = await get(page);
  const m = new RegExp(`action="${action}"[^>]*>\\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"`).exec(r.body);
  assert.ok(m, `form ${action} on ${page}`);
  return m[1];
}
async function nonceForSession(headers: Record<string, string>): Promise<string> {
  const m = /action="\/tokens"[^>]*>\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"/.exec((await get("/tokens", headers)).body);
  assert.ok(m);
  return m[1];
}
// Same-host Origin + valid CSRF + fresh nonce by default; override to break any.
async function post(
  path: string,
  fields: Record<string, string>,
  over: { origin?: string | null; csrf?: string | null; nonce?: string | null; headers?: Record<string, string> } = {},
) {
  const f = { ...fields };
  const t = over.csrf === undefined ? csrf() : over.csrf;
  if (t !== null) f.csrf = t;
  const n = over.nonce === undefined ? await nonceFor(path) : over.nonce;
  if (n !== null) f.nonce = n;
  const headers: Record<string, string> = {
    ...(over.headers ?? ADMIN),
    "content-type": "application/x-www-form-urlencoded",
  };
  const origin = over.origin === undefined ? `http://127.0.0.1:${port}` : over.origin;
  if (origin !== null) headers.origin = origin;
  return request(port, "POST", path, headers, new URLSearchParams(f).toString());
}

// Follows one redirect (always a 303 to a same-app path) with the admin headers.
async function follow(r: Res): Promise<Res> {
  assert.equal(r.status, 303, r.body);
  return get(String(r.headers.location));
}

const mid = (n: number): string => `20210101T000000Z-${n.toString(16).padStart(6, "0")}`;
function manual(id: string, target: string, content: string): void {
  mkdirSync(join(vault, "_inbox"), { recursive: true });
  writeFileSync(
    join(vault, "_inbox", `${id}.md`),
    serializeProposal({ target, proposedBy: "agent-x", reason: "because <b>reason</b>", created: "2021-01-01T00:00:00.000Z", content }),
  );
}

before(async () => {
  writeFileSync(join(vault, "seed.md"), "seed\n");
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);
  web = await import("./web");
  db = (await import("../db")).db;
  tokens = await import("../auth/tokens");
  ({ drainWrites: drain } = await import("../vault/git"));
  const { createTrustedProxy } = await import("../server");
  const app = web.createWebAdminApp({ vaultRoot: vault, trustedProxy: createTrustedProxy("127.0.0.1"), secret: SECRET, proxySecret: PROXY_SECRET });
  server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = (server.address() as AddressInfo).port;
  // Same app, but the only trusted proxy is some other address: this peer is untrusted.
  const other = web.createWebAdminApp({ vaultRoot: vault, trustedProxy: createTrustedProxy("10.254.254.254"), secret: SECRET, proxySecret: PROXY_SECRET });
  proxyOnly = await new Promise<http.Server>((r) => {
    const s = other.listen(0, "127.0.0.1", () => r(s));
  });
  proxyPort = (proxyOnly.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => proxyOnly.close(r));
  cleanup();
});

test("auth: untrusted peer -> 401 even with admin headers", async () => {
  assert.equal((await request(proxyPort, "GET", "/", ADMIN)).status, 401);
  assert.equal((await request(proxyPort, "GET", "/tokens", ADMIN)).status, 401);
});

test("auth: missing or wrong proxy secret -> 401 even from a trusted peer", async () => {
  const { "x-sb-admin-proxy": _drop, ...noSecret } = ADMIN;
  assert.equal((await get("/", noSecret)).status, 401);
  assert.equal((await get("/", { ...ADMIN, "x-sb-admin-proxy": "x".repeat(40) })).status, 401);
  assert.equal((await get("/", { ...ADMIN, "x-sb-admin-proxy": PROXY_SECRET.slice(1) })).status, 401);
  assert.equal((await get("/", { ...ADMIN, "x-sb-admin-proxy": "" })).status, 401);
  assert.equal((await get("/static/style.css", noSecret)).status, 401);
  assert.equal((await post("/tokens", { name: "no-secret", preset: "master-ro", allow_wildcard: "1" }, { headers: noSecret, nonce: "a".repeat(32) })).status, 401);
  assert.equal(tokens.listTokens().filter((t) => t.name === "no-secret").length, 0);
});

test("auth: trusted peer but no identity -> 401; wrong group -> 403; admins -> 200", async () => {
  assert.equal((await get("/", {})).status, 401);
  assert.equal((await get("/", { "remote-groups": "admins" })).status, 401);
  const P = { "x-sb-admin-proxy": PROXY_SECRET };
  assert.equal((await get("/", P)).status, 401);
  assert.equal((await get("/", { ...P, "remote-user": "barlito" })).status, 403);
  assert.equal((await get("/", { ...P, "remote-user": "barlito", "remote-groups": "dev,users" })).status, 403);
  assert.equal((await get("/", { ...P, "remote-user": "barlito", "remote-groups": "superadmins" })).status, 403);
  assert.equal((await get("/")).status, 200);
});

test("auth: static assets are behind auth too", async () => {
  assert.equal((await get("/static/style.css", {})).status, 401);
  assert.equal((await get("/static/style.css", { "x-sb-admin-proxy": PROXY_SECRET })).status, 401);
  const css = await get("/static/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"] ?? "", /text\/css/);
});

test("security headers: strict CSP, frame, referrer", async () => {
  const r = await get("/");
  const csp = String(r.headers["content-security-policy"]);
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "same-origin");
  // Also on error responses
  assert.ok((await get("/nope")).headers["content-security-policy"]);
  assert.ok((await request(port, "GET", "/", {})).headers["content-security-policy"]);
});

test("pages carry no inline style, inline script or inline event handlers (CSP)", async () => {
  manual(mid(70), "sp/pj/notes/csp", "# csp\n");
  const t = tokens.createToken("csp-tok", [{ space: "sp", project: "pj", section: "notes", permission: "read" }]);
  const created = await follow(await post("/tokens", { name: "csp-created", scopes: "sp:pj:notes:read" }));
  const pages = [
    (await get("/")).body,
    (await get("/tokens")).body,
    (await get("/inbox")).body,
    (await get(`/inbox/${mid(70)}`)).body,
    (await get(`/inbox/${mid(70)}?view=raw`)).body,
    (await get("/nope")).body,
    created.body,
  ];
  assert.match(pages[1], new RegExp(t.id), "tokens page rendered");
  for (const body of pages) {
    assert.ok(body.length > 200);
    assert.doesNotMatch(body, /\sstyle\s*=/i);
    assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)/i);
    assert.doesNotMatch(body, /javascript:/i);
  }
  const rejected = await post(`/inbox/${mid(70)}/reject`, {});
  assert.equal(rejected.status, 303);
});

test("dashboard renders health, sync, counts and the user", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.body, /Dashboard/);
  assert.match(r.body, /barlito/);
  assert.match(r.body, /active tokens/);
  assert.match(r.body, /pending proposals/);
  assert.match(r.body, /Conflict branches/);
  assert.match(r.body, /Unpushed commits/);
});

test("csrf: missing/bad token, wrong or missing Origin -> 403 and nothing happens", async () => {
  const f = { name: "csrf-victim", preset: "master-ro", allow_wildcard: "1" };
  assert.equal((await post("/tokens", f, { csrf: null })).status, 403);
  assert.equal((await post("/tokens", f, { csrf: "a".repeat(64) })).status, 403);
  assert.equal((await post("/tokens", f, { csrf: csrf("someone-else") })).status, 403);
  assert.equal((await post("/tokens", f, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post("/tokens", f, { origin: "null" })).status, 403);
  assert.equal((await post("/tokens", f, { origin: null })).status, 403);
  assert.equal((await post("/tokens", f, { origin: null, headers: { ...ADMIN, referer: "http://evil.example/x" } })).status, 403);
  // Referer fallback with the right host is accepted.
  const ok = await post("/tokens", { ...f, name: "csrf-referer" }, { origin: null, headers: { ...ADMIN, referer: `http://127.0.0.1:${port}/tokens` } });
  assert.equal(ok.status, 303);
  assert.equal(tokens.listTokens().filter((t) => t.name === "csrf-victim").length, 0);
});

test("csrf: token is per user and per session and rotates every 4 hours", () => {
  const H = 3_600_000;
  assert.notEqual(web.csrfToken(SECRET, "a", "s"), web.csrfToken(SECRET, "b", "s"));
  assert.notEqual(web.csrfToken(SECRET, "a", "s1"), web.csrfToken(SECRET, "a", "s2"));
  const now = Date.now();
  assert.ok(web.csrfValid(SECRET, "a", "s", web.csrfToken(SECRET, "a", "s", now), now));
  assert.ok(web.csrfValid(SECRET, "a", "s", web.csrfToken(SECRET, "a", "s", now - 4 * H), now), "previous bucket");
  assert.ok(!web.csrfValid(SECRET, "a", "s", web.csrfToken(SECRET, "a", "s", now - 9 * H), now));
  assert.ok(!web.csrfValid("other", "a", "s", web.csrfToken(SECRET, "a", "s", now), now));
  assert.ok(!web.csrfValid(SECRET, "a", "s2", web.csrfToken(SECRET, "a", "s", now), now), "other session");
  assert.ok(!web.csrfValid(SECRET, "a", "", web.csrfToken(SECRET, "a", "", now), now), "no session");
});

test("csrf: a new Authelia session invalidates old tokens; no session cookie refuses POSTs", async () => {
  const f = { name: "sess-victim", preset: "master-ro", allow_wildcard: "1" };
  const { cookie: _c, ...noCookie } = ADMIN;
  const other = { ...ADMIN, cookie: "authelia_session=session-two; other=1" };
  assert.equal((await post("/tokens", f, { csrf: csrf("barlito", "session-old") })).status, 403);
  assert.equal((await post("/tokens", f, { headers: noCookie, csrf: csrf("barlito", "") })).status, 403);
  assert.equal((await post("/tokens", f, { headers: other })).status, 403, "token of session one on session two");
  assert.equal((await post("/tokens", f, { headers: other, csrf: csrf("barlito", "session-two"), nonce: await nonceForSession(other) })).status, 303);
  assert.equal(tokens.listTokens().filter((t) => t.name === "sess-victim").length, 1);
});

test("tokens: create shows plaintext once, never stored in audit or logs", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  let res: Res;
  try {
    res = await post("/tokens", { name: "web-tok", scopes: "sp:pj:notes:write\nsp:pj:notes:read" });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(res.status, 303);
  assert.doesNotMatch(res.body, /sb_/, "the POST itself never renders the plaintext");
  assert.match(String(res.headers.location), /^\/tokens\/created\/[0-9a-f]{32}$/);
  const page = await get(String(res.headers.location));
  assert.equal(page.status, 200);
  const m = /(sb_[A-Za-z0-9_-]{43})/.exec(page.body);
  assert.ok(m, "plaintext token shown");
  const plaintext = m[1];
  assert.match(page.body, /only once/i);
  assert.ok(tokens.verifyToken(plaintext));
  // One-time: a reload of the created page shows nothing
  const again = await get(String(res.headers.location));
  assert.equal(again.status, 404);
  assert.doesNotMatch(again.body, new RegExp(plaintext));
  // Not shown again
  const list = await get("/tokens");
  assert.doesNotMatch(list.body, new RegExp(plaintext));
  assert.match(list.body, /web-tok/);
  assert.match(list.body, /sp:pj:notes:write/);
  // Not in the audit DB nor the logs
  const rows = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
  assert.ok(!rows.includes(plaintext));
  assert.ok(!logs.join("\n").includes(plaintext));
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'admin_token_create' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(a.token_name, "admin:barlito");
  assert.equal(a.result, "ok");
  assert.match(a.detail, /web-tok/);
});

test("tokens: wildcard scopes and presets need the explicit checkbox", async () => {
  const before = tokens.listTokens().length;
  for (const f of [
    { name: "w1", preset: "master" },
    { name: "w2", preset: "master-ro" },
    { name: "w3", scopes: "sp:*:*:read" },
    { name: "w4", scopes: "*:*:*:write" },
  ] as Record<string, string>[]) {
    const r = await post("/tokens", f);
    assert.equal(r.status, 422, JSON.stringify(f));
    assert.match(r.body, /Allow wildcard/);
    assert.match(r.body, /value="w\d"/, "form keeps the input");
  }
  assert.equal(tokens.listTokens().length, before);
  const ok = await follow(await post("/tokens", { name: "w-ok", scopes: "sp:*:*:read\nsp:pj:notes:read", allow_wildcard: "1" }));
  assert.equal(ok.status, 200);
  assert.match(ok.body, /Dropped redundant scope sp:pj:notes:read/);
  const t = tokens.listTokens().find((x) => x.name === "w-ok")!;
  assert.deepEqual(t.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`), ["sp:*:*:read"]);
  assert.equal((await post("/tokens", { name: "w-preset", preset: "master-ro", allow_wildcard: "1" })).status, 303);
});

test("tokens: validation errors are shown inline and escaped", async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ name: "", scopes: "a:b:c:read" }, /name/],
    [{ name: "x", scopes: "" }, /preset or enter/],
    [{ name: "x", scopes: "bad" }, /expected space:project:section:permission/],
    [{ name: "x", scopes: "a:b:c:nope" }, /invalid permission/],
    [{ name: "x", scopes: "A B:b:c:read" }, /invalid space slug/],
    [{ name: "x", scopes: "a:b:c:read", preset: "master" }, /not both/],
    [{ name: "x", preset: "nope" }, /Unknown preset/],
    [{ name: "x", preset: "constructor" }, /Unknown preset/],
    [{ name: "x", preset: "__proto__" }, /Unknown preset/],
    [{ name: "x", preset: "toString" }, /Unknown preset/],
  ];
  for (const [f, re] of cases) {
    const r = await post("/tokens", f);
    assert.equal(r.status, 422, JSON.stringify(f));
    assert.match(r.body, re);
  }
  const xss = await post("/tokens", { name: "<script>alert(1)</script>", scopes: "bad" });
  assert.doesNotMatch(xss.body, /<script>alert/);
  assert.match(xss.body, /&lt;script&gt;/);
});

test("tokens: reload/replay of the create POST creates no second token and flash is shown once", async () => {
  const before = tokens.listTokens().length;
  const nonce = await nonceFor("/tokens");
  const f = { name: "replay-tok", scopes: "sp:pj:notes:read" };
  const first = await post("/tokens", f, { nonce });
  assert.equal(first.status, 303);
  const replay = await post("/tokens", f, { nonce });
  assert.equal(replay.status, 409);
  assert.match(replay.body, /already submitted/);
  assert.equal(tokens.listTokens().length, before + 1);
  assert.equal((await get(String(first.headers.location))).status, 200);
  assert.equal((await get(String(first.headers.location))).status, 404);
  assert.equal(tokens.listTokens().length, before + 1);
  // Another user cannot consume someone else's flash
  const second = await post("/tokens", { ...f, name: "replay-tok-2" });
  const other = { ...ADMIN, "remote-user": "mallory" };
  assert.equal((await get(String(second.headers.location), other)).status, 404);
  assert.equal((await get(String(second.headers.location))).status, 404, "probe consumed it");
  // Unknown or malformed flash/nonce ids
  assert.equal((await get("/tokens/created/" + "0".repeat(32))).status, 404);
  assert.equal((await get("/tokens/created/zzz")).status, 404);
  assert.equal((await post("/tokens", f, { nonce: "0".repeat(32) })).status, 409);
  assert.equal((await post("/tokens", f, { nonce: null })).status, 409);
});

test("tokens: revoke (POST) works, is audited, and a second revoke reports not found", async () => {
  const t = tokens.createToken("to-revoke", [{ space: "sp", project: "pj", section: "notes", permission: "read" }]);
  assert.ok(tokens.verifyToken(t.token));
  const nonce = await nonceFor(`/tokens/${t.id}/revoke`);
  const r = await post(`/tokens/${t.id}/revoke`, {}, { nonce });
  assert.equal(r.status, 303);
  const shown = await follow(r);
  assert.match(shown.body, /revoked/);
  assert.doesNotMatch((await get(String(r.headers.location))).body, /Token .* revoked\./, "flash shown once");
  assert.equal((await post(`/tokens/${t.id}/revoke`, {}, { nonce })).status, 409, "replay");
  assert.equal(tokens.verifyToken(t.token), null);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'admin_token_revoke' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(a.token_name, "admin:barlito");
  assert.equal(a.detail, t.id);
  const again = await follow(await post(`/tokens/${t.id}/revoke`, {}, { nonce: await nonceFor("/tokens") }));
  assert.match(again.body, /not found or already revoked/);
  assert.equal((await post(`/tokens/${t.id}/revoke`, {}, { csrf: null, nonce: "0" })).status, 403);
  assert.equal((await get(`/tokens/${t.id}/revoke`)).status, 404, "GET is not a route");
  assert.equal((await get("/tokens/not-a-uuid/revoke")).status, 404);
});

test("inbox: list and rendered/raw view escape proposal content and render markdown safely", async () => {
  manual(mid(1), "sp/pj/notes/view", "# Title\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n**bold**\n");
  const list = await get("/inbox");
  assert.equal(list.status, 200);
  assert.match(list.body, /sp\/pj\/notes\/view/);
  assert.match(list.body, /agent-x/);
  assert.match(list.body, /because &lt;b&gt;reason&lt;\/b&gt;/);
  const view = await get(`/inbox/${mid(1)}`);
  assert.equal(view.status, 200);
  assert.match(view.body, /<h1>Title<\/h1>/);
  assert.match(view.body, /<strong>bold<\/strong>/);
  assert.doesNotMatch(view.body, /<script>alert/);
  assert.doesNotMatch(view.body, /href="javascript:/);
  const raw = await get(`/inbox/${mid(1)}?view=raw`);
  assert.match(raw.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((await get("/inbox/bad-id")).status, 400);
  assert.equal((await get(`/inbox/${mid(99)}`)).status, 404);
});

test("inbox: accept creates the note (one commit, audited as admin:<user>); overwrite needed on conflict", async () => {
  manual(mid(2), "sp/pj/notes/acc", "accepted body\n");
  const before = Number(git(["rev-list", "--count", "HEAD"], vault).trim());
  const nonce2 = await nonceFor(`/inbox/${mid(2)}/accept`);
  const r = await post(`/inbox/${mid(2)}/accept`, {}, { nonce: nonce2 });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location?.startsWith("/inbox?flash="), true);
  const shown = await get(String(r.headers.location));
  assert.match(shown.body, /Accepted sp\/pj\/notes\/acc/);
  assert.doesNotMatch((await get(String(r.headers.location))).body, /Accepted sp/, "flash shown once");
  // Reload of the POST (same nonce) is refused and does nothing
  assert.equal((await post(`/inbox/${mid(2)}/accept`, {}, { nonce: nonce2 })).status, 409);
  await drain();
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/acc.md"), "utf8")), "accepted body\n");
  assert.equal(existsSync(join(vault, "_inbox", `${mid(2)}.md`)), false);
  assert.equal(Number(git(["rev-list", "--count", "HEAD"], vault).trim()), before + 1);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'inbox_accept' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(a.token_name, "admin:barlito");
  assert.equal(a.result, "ok");

  manual(mid(3), "sp/pj/notes/acc", "second\n");
  const refused = await post(`/inbox/${mid(3)}/accept`, {});
  assert.equal(refused.status, 303);
  assert.equal(refused.headers.location?.startsWith(`/inbox/${mid(3)}?flash=`), true);
  assert.match((await get(String(refused.headers.location))).body, /already exists/);
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/acc.md"), "utf8")), "accepted body\n");
  const ow = await post(`/inbox/${mid(3)}/accept`, { overwrite: "1" });
  assert.equal(ow.status, 303);
  assert.match((await follow(ow)).body, /Accepted sp\/pj\/notes\/acc/);
  await drain();
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/acc.md"), "utf8")), "second\n");

  const gone = await post(`/inbox/${mid(2)}/accept`, {}, { nonce: await nonceFor("/tokens") });
  assert.match((await follow(gone)).body, /proposal not found/);
  assert.equal((await post(`/inbox/${mid(2)}/accept`, {}, { csrf: null, nonce: "0" })).status, 403);
  assert.equal((await post("/inbox/bad-id/accept", {}, { nonce: await nonceFor("/tokens") })).status, 400);
});

test("inbox: reject removes the proposal and audits; invalid proposals are refused with a clear error", async () => {
  manual(mid(4), "sp/pj/notes/rej", "nope\n");
  const r = await post(`/inbox/${mid(4)}/reject`, {});
  assert.equal(r.status, 303);
  assert.match((await follow(r)).body, /Rejected sp\/pj\/notes\/rej/);
  await drain();
  assert.equal(existsSync(join(vault, "_inbox", `${mid(4)}.md`)), false);
  assert.equal(existsSync(join(vault, "sp/pj/notes/rej.md")), false);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'inbox_reject' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(a.token_name, "admin:barlito");
  assert.match((await follow(await post(`/inbox/${mid(4)}/reject`, {}, { nonce: await nonceFor("/tokens") }))).body, /proposal not found/);

  manual(mid(5), "sp/pj/archive/x", "c\n");
  const bad = await post(`/inbox/${mid(5)}/accept`, {});
  assert.equal(bad.status, 303);
  assert.match((await follow(bad)).body, /archive/);
  assert.equal(existsSync(join(vault, "_inbox", `${mid(5)}.md`)), true);
});

test("startWebAdmin refuses to start without TRUSTED_PROXY", async () => {
  const { createTrustedProxy } = await import("../server");
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    assert.equal(await web.startWebAdmin(vault, undefined, createTrustedProxy(undefined), {}, 0), undefined);
    assert.equal(await web.startWebAdmin(vault, undefined, createTrustedProxy(" "), { TRUSTED_PROXY: " ", ADMIN_PROXY_SECRET: PROXY_SECRET }, 0), undefined);
  } finally {
    console.error = orig;
  }
  assert.match(errs.join("\n"), /TRUSTED_PROXY is not set/);
});

test("startWebAdmin refuses to start without a strong ADMIN_PROXY_SECRET", async () => {
  const { createTrustedProxy } = await import("../server");
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    const tp = createTrustedProxy("127.0.0.1");
    assert.equal(await web.startWebAdmin(vault, undefined, tp, { TRUSTED_PROXY: "127.0.0.1" }, 0), undefined);
    assert.equal(await web.startWebAdmin(vault, undefined, tp, { TRUSTED_PROXY: "127.0.0.1", ADMIN_PROXY_SECRET: "short" }, 0), undefined);
    assert.equal(await web.startWebAdmin(vault, undefined, tp, { TRUSTED_PROXY: "127.0.0.1", ADMIN_PROXY_SECRET: "p".repeat(31) }, 0), undefined);
    assert.throws(() => web.createWebAdminApp({ vaultRoot: vault, trustedProxy: tp, proxySecret: "p".repeat(31) }));
  } finally {
    console.error = orig;
  }
  assert.match(errs.join("\n"), /ADMIN_PROXY_SECRET must be set/);
});

test("startWebAdmin binds all interfaces, is tracked by the lifecycle and closed by shutdown", async () => {
  const { createTrustedProxy, Lifecycle, createShutdown } = await import("../server");
  const { withAdmin } = await import("../admin");
  const lc = new Lifecycle();
  const s = await web.startWebAdmin(vault, lc, createTrustedProxy("127.0.0.1"), { TRUSTED_PROXY: "127.0.0.1", ADMIN_GROUP: "ops", ADMIN_PROXY_SECRET: PROXY_SECRET }, 0);
  assert.ok(s);
  const addr = s.address() as AddressInfo;
  assert.match(addr.address, /^(::|0\.0\.0\.0)$/);
  // Custom admin group is honoured
  assert.equal((await request(addr.port, "GET", "/", ADMIN)).status, 403);
  assert.equal((await request(addr.port, "GET", "/", { ...ADMIN, "remote-groups": "ops" })).status, 200);

  const main = http.createServer();
  await new Promise<void>((r) => main.listen(0, "127.0.0.1", r));
  const exits: number[] = [];
  const shutdown = createShutdown({
    server: withAdmin(main, s),
    lifecycle: lc,
    closeDb: () => undefined,
    exit: (c) => exits.push(c),
  });
  await shutdown("SIGTERM");
  assert.equal(s.listening, false);
  assert.equal(main.listening, false);
  assert.deepEqual(exits, [0]);
});

test("dashboard survives a broken database: unhealthy badge and n/a counts, no 500", async () => {
  const orig = db.prepare;
  (db as unknown as { prepare: () => never }).prepare = () => {
    throw new Error("database is closed");
  };
  let r: Res;
  try {
    r = await get("/");
  } finally {
    delete (db as unknown as { prepare?: unknown }).prepare;
  }
  assert.equal(db.prepare, orig);
  assert.equal(r.status, 200);
  assert.match(r.body, /Database: <span class="badge err">error<\/span>/);
  assert.equal((r.body.match(/<div class="n">n\/a<\/div>/g) ?? []).length, 2, "token and audit counts are n/a");
  assert.match(r.body, /Vault: <span class="badge ok">/);
  // Healthy again afterwards
  assert.match((await get("/")).body, /Database: <span class="badge ok">/);
});

test("tokens: expiry field on create, expiry/expired in the table, dashboard counts only live tokens", async () => {
  const stat = async (): Promise<number> => Number(/<div class="n">(\d+)<\/div><div class="l">active tokens/.exec((await get("/")).body)![1]);
  const before = await stat();

  const bad = await post("/tokens", { name: "exp-bad", scopes: "sp:pj:notes:read", expires_in_days: "0" });
  assert.equal(bad.status, 422);
  assert.equal((await post("/tokens", { name: "exp-bad2", scopes: "sp:pj:notes:read", expires_in_days: "abc" })).status, 422);
  assert.equal(tokens.listTokens().filter((t) => t.name.startsWith("exp-bad")).length, 0);

  const res = await post("/tokens", { name: "exp-ok", scopes: "sp:pj:notes:read", expires_in_days: "7" });
  assert.equal(res.status, 303);
  const page = await get(String(res.headers.location));
  const row = tokens.listTokens().find((t) => t.name === "exp-ok")!;
  assert.ok(row.expires_at);
  assert.ok(page.body.includes(row.expires_at!), "created page shows expiry");
  assert.equal(await stat(), before + 1);

  const list = await get("/tokens");
  assert.ok(list.body.includes(row.expires_at!), "table shows expiry");

  db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
  const expired = await get("/tokens");
  assert.match(expired.body, /<span class="badge err">expired<\/span>/);
  assert.equal(await stat(), before, "expired token not counted as active");
  assert.match(expired.body, new RegExp(`/tokens/${row.id}/revoke`), "revoke still offered");
});

test("tokens: preset project grants meta read + own project, needs no wildcard checkbox, shows the claude command", async () => {
  const ok = await follow(await post("/tokens", { name: "proj-tok", preset: "project", project: "pro/my-proj", dir: "/home/me/my proj" }));
  assert.equal(ok.status, 200);
  const t = tokens.listTokens().find((x) => x.name === "proj-tok")!;
  assert.deepEqual(
    t.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`),
    ["meta:*:*:read", "pro:my-proj:*:read", "pro:my-proj:*:write"],
  );
  assert.doesNotMatch(ok.body, /WARNING|Allow wildcard/);
  const plaintext = /(sb_[A-Za-z0-9_-]{43})/.exec(ok.body)![1];
  // The textarea holds the command; quotes are HTML-escaped but a browser reads them back.
  assert.ok(
    ok.body.includes(`cd &#39;/home/me/my proj&#39; &amp;&amp; claude mcp add --scope local --transport http second-brain https://second-brain.barlito.fr/mcp --header &quot;Authorization: Bearer ${plaintext}&quot;`),
    "command with quoted dir",
  );
  assert.match(ok.body, /data-copy="claude-cmd"/);
  assert.match(ok.body, /inside the project directory/);
  // Not persisted: neither audit nor the tokens page carries it.
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM audit_log").all()).includes("claude mcp add"));
  assert.doesNotMatch((await get("/tokens")).body, /claude mcp add/);
});

test("tokens: any token page shows the command without cd when no directory is given", async () => {
  const r = await follow(await post("/tokens", { name: "nodir-tok", scopes: "sp:pj:notes:read" }));
  assert.match(r.body, />claude mcp add --scope local --transport http second-brain /);
  assert.doesNotMatch(r.body, /&amp;&amp; claude/);
});

test("tokens: preset project validation, extras and the dir field", async () => {
  const before = tokens.listTokens().length;
  const bad: Array<[Record<string, string>, RegExp]> = [
    [{ name: "x", preset: "project" }, /needs project=&lt;space&gt;\/&lt;project&gt;/],
    [{ name: "x", preset: "project", project: "pro" }, /two slugs/],
    [{ name: "x", preset: "project", project: "pro/a/b" }, /two slugs/],
    [{ name: "x", preset: "project", project: "pro/My Proj" }, /two slugs/],
    [{ name: "x", preset: "project", project: "../x" }, /two slugs/],
    [{ name: "x", preset: "project", project: "pro/p", dir: "a\nb" }, /control characters/],
    [{ name: "x", preset: "project", project: "pro/p", scopes: "sp:*:*:read" }, /Allow wildcard/],
  ];
  for (const [f, re] of bad) {
    const r = await post("/tokens", f);
    assert.equal(r.status, 422, JSON.stringify(f));
    assert.match(r.body, re);
  }
  assert.equal(tokens.listTokens().length, before);
  assert.match((await get("/tokens")).body, /<datalist id="projects">/);
  // Extras combine; confirmed wildcard extras are allowed.
  const ok = await post("/tokens", { name: "proj-extra", preset: "project", project: "pro/p", scopes: "sp:pj:notes:read\nsp:*:*:read", allow_wildcard: "1" });
  assert.equal(ok.status, 303);
  const scopes = tokens.listTokens().find((x) => x.name === "proj-extra")!.scopes.map((s) => `${s.space}:${s.project}:${s.section}:${s.permission}`);
  assert.ok(scopes.includes("pro:p:*:write") && scopes.includes("sp:*:*:read") && !scopes.includes("sp:pj:notes:read"));
});
