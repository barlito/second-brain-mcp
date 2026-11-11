import "./server.helpers.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import type { Response } from "express";
import { cleanupDirs, lastAudit, listen, newRepo, tmp } from "./server.helpers.test";

let server: typeof import("./server");
let db: typeof import("./db").db;
let token: string;

before(async () => {
  server = await import("./server");
  ({ db } = await import("./db"));
  const { createToken } = await import("./auth/tokens");
  token = createToken("hardening", [{ project: "p", section: "s", permission: "read" }]).token;
});
after(cleanupDirs);

const rpc = (id: number) => JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id });
const post = (baseUrl: string, headers: Record<string, string>, body = rpc(1)) =>
  fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

// ---- shutdown ordering ----------------------------------------------------

test("shutdown waits for in-flight requests before draining writes; new requests get 503", async () => {
  const lifecycle = new server.Lifecycle();
  const app = await listen(server.createApp({ vaultRoot: newRepo(), lifecycle }));
  const events: string[] = [];
  const exits: number[] = [];
  const fakeRes = new EventEmitter() as unknown as Response;
  lifecycle.enter(fakeRes);

  const shutdown = server.createShutdown({
    server: app.server,
    lifecycle,
    closeDb: () => undefined,
    abortPushes: () => events.push("abortPushes"),
    drain: async () => void events.push("drain"),
    exit: (c) => exits.push(c),
  });
  const done = shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events, ["abortPushes"], "drain must wait for the in-flight request");
  assert.deepEqual(exits, []);

  // Late arrival on an existing keep-alive path: refused with JSON-RPC 503.
  const late = new EventEmitter() as unknown as Response;
  assert.equal(lifecycle.shuttingDown, true);
  lifecycle.enter(late);
  late.emit("close");

  (fakeRes as unknown as EventEmitter).emit("finish");
  await done;
  assert.deepEqual(events, ["abortPushes", "drain"]);
  assert.deepEqual(exits, [0]);
});

test("while shutting down /mcp answers 503 JSON-RPC", async () => {
  const lifecycle = new server.Lifecycle();
  lifecycle.shuttingDown = true;
  const app = await listen(server.createApp({ vaultRoot: newRepo(), lifecycle }));
  try {
    const res = await post(app.baseUrl, {});
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, "Server is shutting down");
  } finally {
    await app.close();
  }
});

test("shutdown cap covers a stuck in-flight request", async () => {
  const lifecycle = new server.Lifecycle();
  lifecycle.enter(new EventEmitter() as unknown as Response); // never finishes
  const app = await listen(server.createApp({ vaultRoot: newRepo(), lifecycle }));
  const exits: number[] = [];
  const shutdown = server.createShutdown({
    server: app.server,
    lifecycle,
    closeDb: () => undefined,
    abortPushes: () => undefined,
    drain: async () => undefined,
    drainTimeoutMs: 50,
    exit: (c) => exits.push(c),
  });
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
});

// ---- listen errors / bootstrap abort ---------------------------------------

test("listen rejects when the port is taken", async () => {
  const first = await listen(server.createApp({ vaultRoot: newRepo() }));
  try {
    const port = (first.server.address() as { port: number }).port;
    await assert.rejects(server.listen(server.createApp({ vaultRoot: newRepo() }), port), /EADDRINUSE/);
  } finally {
    await first.close();
  }
});

test("initVault stops before touching anything when a signal is pending", async () => {
  const dir = tmp("abort");
  await assert.rejects(server.initVault(dir, {}, () => true), /bootstrap aborted/);
  assert.deepEqual(readdirSync(dir), []);
});

// ---- trusted proxy ---------------------------------------------------------

test("trusted proxy: IPs, CIDRs and resolved hostnames; DNS never blocks trust()", async () => {
  let answer: string[] | Error = ["172.20.0.5"];
  const tp = server.createTrustedProxy("10.0.0.0/8, 192.168.1.1, tasks.traefik", async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  try {
    assert.equal(tp.trust("10.9.8.7"), true);
    assert.equal(tp.trust("192.168.1.1"), true);
    assert.equal(tp.trust("172.20.0.5"), false, "hostname not resolved yet");
    await tp.refresh();
    assert.equal(tp.trust("172.20.0.5"), true);
    assert.equal(tp.trust("::ffff:172.20.0.5"), true);
    assert.equal(tp.trust("172.20.0.6"), false);

    answer = new Error("ENOTFOUND");
    const orig = console.error;
    console.error = () => undefined;
    try {
      await tp.refresh();
    } finally {
      console.error = orig;
    }
    assert.equal(tp.trust("172.20.0.5"), true, "last good answer kept on DNS failure");

    answer = ["172.20.0.9"];
    await tp.refresh();
    assert.equal(tp.trust("172.20.0.5"), false);
    assert.equal(tp.trust("172.20.0.9"), true);
  } finally {
    tp.stop();
  }
  assert.equal(server.createTrustedProxy(undefined).trust("10.0.0.1"), false);
});

async function clientIpSeenFor(trustedProxy: import("./server").TrustedProxy | undefined, xff: string) {
  const app = await listen(server.createApp({ vaultRoot: newRepo(), trustedProxy }));
  try {
    await fetch(`${app.baseUrl}/health/details`, { headers: { "X-Forwarded-For": xff } });
    return lastAudit(db, "action = 'auth'").client_ip;
  } finally {
    await app.close();
  }
}

test("X-Forwarded-For is honoured only from a trusted peer", async () => {
  assert.equal(await clientIpSeenFor(server.createTrustedProxy("127.0.0.1"), "9.9.9.9"), "9.9.9.9");
  assert.match((await clientIpSeenFor(server.createTrustedProxy("10.0.0.0/8"), "9.9.9.8")) ?? "", /127\.0\.0\.1/);
  assert.match((await clientIpSeenFor(undefined, "9.9.9.7")) ?? "", /127\.0\.0\.1/);
});

// ---- error handler ---------------------------------------------------------

test("body-parser 4xx errors keep their status instead of becoming 500", async () => {
  const app = await listen(server.createApp({ vaultRoot: newRepo() }));
  try {
    const res = await post(app.baseUrl, { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=bogus" });
    assert.equal(res.status, 415);
    const body = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /unsupported charset/i);
  } finally {
    await app.close();
  }
});

// ---- auth failure limiter ---------------------------------------------------

test("limiter: blocks after max failures per window, resets after it, bounds its size", () => {
  let t = 0;
  const l = new server.AuthFailureLimiter(3, 1000, 2, () => t);
  assert.deepEqual(l.record("a"), { audit: true, previous: 0 });
  assert.deepEqual(l.record("a"), { audit: false, previous: 0 });
  assert.equal(l.blocked("a"), false);
  l.record("a");
  assert.equal(l.blocked("a"), true);
  assert.equal(l.blocked("b"), false);
  t = 1000;
  assert.equal(l.blocked("a"), false);
  assert.deepEqual(l.record("a"), { audit: true, previous: 3 });

  l.record("b");
  l.record("c"); // evicts the oldest entry
  assert.equal((l as unknown as { map: Map<string, unknown> }).map.size, 2);
});

test("repeated bad tokens: 401s, then 429 without DB work, one coalesced audit row", async () => {
  const limiter = new server.AuthFailureLimiter(3, 60_000);
  const tp = server.createTrustedProxy("127.0.0.1");
  const app = await listen(server.createApp({ vaultRoot: newRepo(), authLimiter: limiter, trustedProxy: tp }));
  const ip = "203.0.113.77";
  const count = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth' AND client_ip = ?").get(ip) as { n: number }).n;
  try {
    const headers = { Authorization: "Bearer nope", "X-Forwarded-For": ip };
    for (let i = 0; i < 3; i++) assert.equal((await post(app.baseUrl, headers)).status, 401);
    assert.equal(count(), 1);
    const res = await post(app.baseUrl, headers);
    assert.equal(res.status, 429);
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    assert.equal(body.error.message, "Too many failed authentications");
    assert.equal(count(), 1);

    // Even a valid token from the blocked IP is refused before touching the DB.
    assert.equal((await post(app.baseUrl, { Authorization: `Bearer ${token}`, "X-Forwarded-For": ip })).status, 429);
    // Another IP is unaffected.
    assert.notEqual((await post(app.baseUrl, { Authorization: `Bearer ${token}`, "X-Forwarded-For": "203.0.113.78" })).status, 429);
  } finally {
    await app.close();
    tp.stop();
  }
});

test("a failing audit write still yields 401", async () => {
  const app = await listen(server.createApp({ vaultRoot: newRepo() }));
  db.exec("ALTER TABLE audit_log RENAME TO audit_log_off");
  const orig = console.error;
  console.error = () => undefined;
  try {
    const res = await post(app.baseUrl, { Authorization: "Bearer nope" });
    assert.equal(res.status, 401);
  } finally {
    console.error = orig;
    db.exec("ALTER TABLE audit_log_off RENAME TO audit_log");
    await app.close();
  }
});
