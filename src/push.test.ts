import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { cleanup, makeTempDb } from "./test-support/fixtures";

makeTempDb();
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_PER_SESSION = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";

type Push = typeof import("./push");
let push: Push;
let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");
let keys: typeof import("./auth/connectorKeys");
let sealed: typeof import("./auth/sealed");
let db: typeof import("./db").db;

const P256DH = randomBytes(65).toString("base64url");
const AUTH = randomBytes(16).toString("base64url");
const sub = (n: number, over: Record<string, string> = {}) => ({ endpoint: `https://push.example.test/send/${n}`, p256dh: P256DH, auth: AUTH, label: `device ${n}`, ...over });

interface Sent {
  endpoint: string;
  payload: Record<string, unknown>;
  ttl: number;
  vapidPublic: string;
  topic?: string;
}
function recorder(fail?: (endpoint: string) => unknown) {
  const sent: Sent[] = [];
  const send: import("./push").Sender = async (t, payload, o) => {
    const err = fail?.(t.endpoint);
    if (err) throw err;
    sent.push({ endpoint: t.endpoint, payload: JSON.parse(payload), ttl: o.ttl, topic: o.topic, vapidPublic: o.vapid.publicKey });
  };
  return { sent, send };
}
const tick = () => new Promise((r) => setImmediate(r));

before(async () => {
  db = (await import("./db")).db;
  push = await import("./push");
  access = await import("./access");
  sessions = await import("./auth/sessions");
  keys = await import("./auth/connectorKeys");
  sealed = await import("./auth/sealed");
});
after(cleanup);

test("seal helper keeps connector keys byte-compatible and revealable", () => {
  // Same construction as the pre-extraction code: HKDF(secret, "", "connector-keys-v1"), nonce|tag|ct, AAD = row id.
  const k = keys.createConnectorKey("compat", "s3cret");
  const row = db.prepare("SELECT id, key_enc FROM connector_keys WHERE id = ?").get(k.id) as { id: string; key_enc: string };
  assert.equal(sealed.unseal(row.key_enc, row.id, "s3cret", "connector-keys-v1"), k.key);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", "s3cret", "", "connector-keys-v1", 32)), nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from("rowid"));
  const ct = Buffer.concat([c.update("plain", "utf8"), c.final()]);
  const legacy = Buffer.concat([nonce, c.getAuthTag(), ct]).toString("base64");
  assert.equal(sealed.unseal(legacy, "rowid", "s3cret", "connector-keys-v1"), "plain");
  assert.equal(sealed.unseal(legacy, "rowid", "s3cret", "vapid-v1"), null, "labels are separate keys");
  assert.equal(sealed.unseal(legacy, "other", "s3cret", "connector-keys-v1"), null);
  assert.equal(keys.revealConnectorKey({ id: k.id }, "s3cret").status, "ok");
});

test("VAPID keypair: generated once, private key sealed, stable across services", () => {
  const a = push.createPushService({ secret: "secret-a" });
  const pub = a.publicKey();
  assert.equal(Buffer.from(pub, "base64url").length, 65);
  const row = db.prepare("SELECT * FROM push_vapid").get() as { public_key: string; private_key_sealed: string };
  assert.equal(row.public_key, pub);
  const priv = sealed.unseal(row.private_key_sealed, "vapid", "secret-a", "vapid-v1");
  assert.equal(Buffer.from(priv as string, "base64url").length, 32);
  assert.ok(!row.private_key_sealed.includes(priv as string));
  assert.equal(push.createPushService({ secret: "secret-a" }).publicKey(), pub);
});

test("an unsealable VAPID key is regenerated, subscriptions are cleared, one warning is logged", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const a = push.createPushService({ secret: "secret-a" });
  const before = a.publicKey();
  a.add(sub(1), "alice");
  assert.equal(a.list().length, 1);
  const b = push.createPushService({ secret: "secret-b" });
  const after = b.publicKey();
  assert.notEqual(after, before);
  assert.equal(b.list().length, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(push.createPushService({ secret: "secret-b" }).publicKey(), after);
  assert.equal(warn.mock.callCount(), 1);
});

test("subscription validation", () => {
  const ok = push.parseSubscription(sub(1, { label: "  Pixel  " }));
  assert.equal(ok.label, "Pixel");
  const bad = (over: Record<string, string>) => assert.throws(() => push.parseSubscription(sub(1, over)), push.PushError);
  bad({ endpoint: "http://push.example.test/x" });
  bad({ endpoint: "not a url" });
  bad({ endpoint: "https://user:pass@push.example.test/x" });
  bad({ endpoint: `https://push.example.test/${"a".repeat(1100)}` });
  bad({ p256dh: "short" });
  bad({ p256dh: `${P256DH}!` });
  bad({ auth: randomBytes(8).toString("base64url") });
  bad({ label: "" });
  bad({ label: "x".repeat(65) });
  bad({ label: "bad\nlabel" });
  assert.throws(() => push.parseSubscription({}), push.PushError);
});

test("add upserts on endpoint, caps the number of devices, remove deletes", () => {
  db.prepare("DELETE FROM push_subscriptions").run();
  const svc = push.createPushService({ secret: "secret-b" });
  const first = svc.add(sub(1), "alice");
  const again = svc.add(sub(1, { label: "renamed" }), "alice");
  assert.equal(again.id, first.id);
  assert.equal(svc.list().length, 1);
  assert.equal(svc.list()[0].label, "renamed");
  for (let i = 2; i <= push.MAX_SUBSCRIPTIONS; i++) svc.add(sub(i), "alice");
  assert.throws(() => svc.add(sub(99), "alice"), push.PushError);
  svc.add(sub(2, { label: "still fine" }), "alice");
  assert.equal(svc.remove(first.id), true);
  assert.equal(svc.remove(first.id), false);
  assert.equal(svc.list().length, push.MAX_SUBSCRIPTIONS - 1);
  db.prepare("DELETE FROM push_subscriptions").run();
});

test("sendToAll: parallel, last_ok_at on success, 410/404 delete, other errors keep the device and log without the endpoint", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  db.prepare("DELETE FROM push_subscriptions").run();
  const r = recorder((e) => (e.endsWith("/2") ? Object.assign(new Error("gone"), { statusCode: 410 }) : e.endsWith("/3") ? Object.assign(new Error("nf"), { statusCode: 404 }) : e.endsWith("/4") ? new Error("boom https://push.example.test/send/4") : null));
  const svc = push.createPushService({ secret: "secret-b", send: r.send });
  for (const n of [1, 2, 3, 4]) svc.add(sub(n), "alice");
  assert.equal(await svc.sendToAll({ hello: 1 }, 60), 1);
  assert.deepEqual(svc.list().map((s) => s.label), ["device 1", "device 4"]);
  assert.ok(svc.list()[0].last_ok_at);
  assert.equal(svc.list()[1].last_ok_at, null);
  assert.equal(r.sent[0].ttl, 60);
  assert.equal(warn.mock.callCount(), 1);
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /push\.example\.test/);
  db.prepare("DELETE FROM push_subscriptions").run();
});

test("a hanging sender times out and does not reject", async (t) => {
  t.mock.method(console, "warn", () => {});
  const svc = push.createPushService({ secret: "secret-b", send: () => new Promise(() => {}), timeoutMs: 30 });
  svc.add(sub(1), "alice");
  assert.equal(await svc.sendToAll({ x: 1 }, 60), 0);
  assert.equal(svc.list().length, 1);
  db.prepare("DELETE FROM push_subscriptions").run();
});

test("access events: a created request sends the payload with its TTL and topic; nothing else is pushed", async () => {
  db.prepare("DELETE FROM push_subscriptions").run();
  const r = recorder();
  const svc = push.createPushService({ secret: "secret-b", send: r.send });
  svc.add(sub(1), "alice");
  const off = push.attachAccessPush(svc);
  try {
    const s = sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.7" });
    const a = access.createAccessRequest(s.id, { space: "pro", project: "alpha", access: "write", reason: "why" }).request;
    await tick();
    assert.equal(r.sent.length, 1);
    assert.deepEqual(r.sent[0].payload, { tag: a.id, title: "Access request", body: "Claude Code · write pro/alpha", url: `/access#req-${a.id}` });
    assert.equal(r.sent[0].topic, a.id.replace(/-/g, ""));
    assert.ok(r.sent[0].topic && r.sent[0].topic.length <= 32);
    assert.ok(r.sent[0].ttl > 14 * 60 && r.sent[0].ttl <= 15 * 60, `ttl ${r.sent[0].ttl}`);
    assert.equal(r.sent[0].vapidPublic, svc.publicKey());

    // Same pending request again: no second notification.
    access.createAccessRequest(s.id, { space: "pro", project: "alpha", access: "write", reason: "why" });
    await tick();
    assert.equal(r.sent.length, 1);

    const b = access.createAccessRequest(s.id, { scopes: ["pro:beta:*:read", "pro:gamma:*:read"], reason: "why" }).request;
    await tick();
    assert.equal(r.sent[1].payload.body, "Claude Code · 2 scopes");
    assert.equal(r.sent[1].payload.tag, b.id);

    // Deciding or revoking sends nothing (stale notifications are closed client side).
    access.approveRequest(a.id, { actor: "admin:alice" });
    access.denyRequest(b.id, "admin:alice");
    await tick();
    assert.equal(r.sent.length, 2);

    // An elevation request is marked as such.
    access.createAccessRequest(s.id, { space: "pro", project: "delta", access: "read", reason: "why" });
    await tick();
    assert.equal(r.sent[2].payload.body, "Elevation: Claude Code · read pro/delta");
    sessions.revokeSession(s.id);
    access.auditSessionRevoke("admin:alice", s.id, true);
    await tick();
    assert.equal(r.sent.length, 3);
  } finally {
    off();
    db.prepare("DELETE FROM push_subscriptions").run();
  }
});

test("a push service that throws never reaches createAccessRequest", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const broken = {
    sendToAll: () => {
      throw new Error("sync boom");
    },
  } as unknown as import("./push").PushService;
  const off = push.attachAccessPush(broken);
  try {
    const s = sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.10" });
    assert.equal(access.createAccessRequest(s.id, { space: "pro", project: "alpha", access: "read", reason: "why" }).created, true);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    off();
  }
});

test("a throwing sender and a throwing listener never break createAccessRequest", async (t) => {
  t.mock.method(console, "warn", () => {});
  db.prepare("DELETE FROM push_subscriptions").run();
  const svc = push.createPushService({
    secret: "secret-b",
    send: () => {
      throw new Error("sync boom");
    },
  });
  svc.add(sub(1), "alice");
  const off = push.attachAccessPush(svc);
  const offBad = access.onAccessRequestEvent(() => {
    throw new Error("listener boom");
  });
  try {
    const s = sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.8" });
    const res = access.createAccessRequest(s.id, { space: "pro", project: "alpha", access: "read", reason: "why" });
    assert.equal(res.created, true);
    access.denyRequest(res.request.id, "admin:alice");
    await tick();
  } finally {
    off();
    offBad();
    db.prepare("DELETE FROM push_subscriptions").run();
  }
});
