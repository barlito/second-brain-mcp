import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { cleanup, makeTempDb, makeTempVault } from "../test-support/fixtures";

makeTempDb();
const { vault } = makeTempVault();

let web: typeof import("./web");
let push: typeof import("../push");
let db: typeof import("../db").db;
let server: http.Server;
let port: number;
let delivered: string[] = [];
let failWith: unknown;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}
function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, text: b.toString("utf8") });
      });
    });
    r.on("error", reject);
    r.end(body);
  });
}

const SECRET = "test-secret";
const PROXY_SECRET = "p".repeat(40);
const ADMIN = { "remote-user": "alice", "remote-groups": "admins", "x-sb-admin-proxy": PROXY_SECRET, cookie: "authelia_session=s1" };
const get = (path: string, h: Record<string, string> = ADMIN) => request("GET", path, h);

async function nonceFor(action: string): Promise<string> {
  const r = await get("/access");
  const m = new RegExp(`action="${action}"[^>]*>\\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"`).exec(r.text);
  assert.ok(m, `form ${action}`);
  return m[1];
}
async function post(path: string, fields: Record<string, string>, over: { csrf?: string | null; nonce?: string | null } = {}, formAction = path): Promise<Res> {
  const f = { ...fields };
  const t = over.csrf === undefined ? web.csrfToken(SECRET, "alice", "s1") : over.csrf;
  if (t !== null) f.csrf = t;
  const n = over.nonce === undefined ? await nonceFor(formAction) : over.nonce;
  if (n !== null) f.nonce = n;
  return request("POST", path, { ...ADMIN, "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, new URLSearchParams(f).toString());
}
async function follow(r: Res): Promise<Res> {
  assert.equal(r.status, 303, r.text);
  return get(String(r.headers.location));
}

const sub = (n: number, over: Record<string, string> = {}) => ({
  endpoint: `https://push.example.test/send/${n}`,
  p256dh: randomBytes(65).toString("base64url"),
  auth: randomBytes(16).toString("base64url"),
  label: `Phone ${n}`,
  ...over,
});

before(async () => {
  web = await import("./web");
  push = await import("../push");
  db = (await import("../db")).db;
  const { createTrustedProxy } = await import("../server");
  const service = push.createPushService({
    secret: SECRET,
    send: async (t) => {
      if (failWith) throw failWith;
      delivered.push(t.endpoint);
    },
  });
  const app = web.createWebAdminApp({ vaultRoot: vault, trustedProxy: createTrustedProxy("127.0.0.1"), secret: SECRET, proxySecret: PROXY_SECRET, push: service });
  server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  cleanup();
});

test("manifest, service worker and icons need the admin auth like every page", async () => {
  for (const p of ["/manifest.webmanifest", "/sw.js", "/static/icon-192.png", "/static/icon-512.png"]) {
    assert.equal((await get(p, {})).status, 401, p);
    assert.equal((await get(p, { ...ADMIN, "remote-groups": "users" })).status, 403, p);
    assert.equal((await get(p)).status, 200, p);
  }
});

test("manifest content, service worker headers, icons are PNG, head links, CSP", async () => {
  const m = await get("/manifest.webmanifest");
  assert.match(String(m.headers["content-type"]), /^application\/manifest\+json/);
  const j = JSON.parse(m.text);
  assert.equal(j.start_url, "/access");
  assert.equal(j.display, "standalone");
  assert.deepEqual(j.icons.map((i: { sizes: string }) => i.sizes), ["192x192", "512x512"]);
  const sw = await get("/sw.js");
  assert.match(String(sw.headers["content-type"]), /^application\/javascript/);
  assert.equal(sw.headers["cache-control"], "no-cache");
  assert.match(sw.text, /showNotification/);
  assert.doesNotMatch(sw.text, /addEventListener\("fetch"/);
  for (const [p, size] of [["/static/icon-192.png", 192], ["/static/icon-512.png", 512]] as const) {
    const i = await get(p);
    assert.equal(i.headers["content-type"], "image/png");
    assert.equal(i.body.subarray(1, 4).toString(), "PNG");
    assert.equal(i.body.readUInt32BE(16), size);
  }
  const page = await get("/access");
  assert.match(page.text, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/);
  assert.match(page.text, /<meta name="theme-color"/);
  assert.match(page.text, /<link rel="apple-touch-icon"/);
  assert.match(String(page.headers["content-security-policy"]), /manifest-src 'self'; worker-src 'self'/);
});

test("access page: notifications section exposes the public key, request anchor exists", async () => {
  const page = await get("/access");
  assert.match(page.text, new RegExp(`id="push" data-vapid-key="${push.createPushService({ secret: SECRET }).publicKey()}"`));
  assert.match(page.text, /action="\/push\/subscribe"/);
  const { createSession } = await import("../auth/sessions");
  const { createAccessRequest } = await import("../access");
  const s = createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.9" });
  const r = createAccessRequest(s.id, { space: "pro", project: "alpha", access: "read", reason: "why" }).request;
  assert.match((await get("/access")).text, new RegExp(`id="req-${r.id}"`));
});

test("subscribe: CSRF and nonce required, then stored, audited, listed; invalid input is a banner", async () => {
  db.prepare("DELETE FROM push_subscriptions").run();
  assert.equal((await post("/push/subscribe", sub(1), { csrf: null })).status, 403);
  assert.equal((await post("/push/subscribe", sub(1), { csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post("/push/subscribe", sub(1), { nonce: null })).status, 409);
  assert.equal((await post("/push/subscribe", sub(1), { nonce: "f".repeat(32) })).status, 409);
  assert.equal(push.createPushService({ secret: SECRET }).list().length, 0);

  const ok = await follow(await post("/push/subscribe", sub(1), {}, "/push/subscribe"));
  assert.match(ok.text, /Notifications enabled on Phone 1\./);
  assert.match(ok.text, /<td>Phone 1<\/td>/);
  assert.equal((db.prepare("SELECT user FROM push_subscriptions").get() as { user: string }).user, "alice");
  const audit = db.prepare("SELECT result FROM audit_log WHERE action = 'push_subscribe'").all() as Array<{ result: string }>;
  assert.deepEqual(audit.map((a) => a.result), ["ok"]);

  const bad = await follow(await post("/push/subscribe", sub(2, { endpoint: "http://insecure.example.test/x" })));
  assert.match(bad.text, /must be an https URL/);
  assert.equal(push.createPushService({ secret: SECRET }).list().length, 1);
});

test("test notification reaches every device; failure explains; remove deletes", async () => {
  db.prepare("DELETE FROM push_subscriptions").run();
  delivered = [];
  const svc = push.createPushService({ secret: SECRET });
  svc.add(sub(1), "alice");
  svc.add(sub(2), "alice");
  const ok = await follow(await post("/push/test", {}, {}, "/push/test"));
  assert.match(ok.text, /Test sent to 2 devices\./);
  assert.deepEqual(delivered.sort(), ["https://push.example.test/send/1", "https://push.example.test/send/2"]);

  failWith = new Error("network down");
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.match((await follow(await post("/push/test", {}, {}, "/push/test"))).text, /No device could be reached/);
  } finally {
    console.warn = origWarn;
    failWith = undefined;
  }

  const id = svc.list()[0].id;
  assert.equal((await post(`/push/${id}/remove`, {}, { csrf: null })).status, 403);
  const gone = await follow(await post(`/push/${id}/remove`, {}, {}, `/push/${id}/remove`));
  assert.match(gone.text, /Device removed\./);
  assert.equal(svc.list().length, 1);
  const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'push_%' ORDER BY id").all() as Array<{ action: string }>).map((a) => a.action);
  assert.ok(actions.includes("push_test") && actions.includes("push_remove"));
});
