import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb } from "./test-support/fixtures";

makeTempDb();
process.env.ACCESS_MAX_PENDING_PER_IP = "1000";
process.env.ACCESS_MAX_PENDING_TOTAL = "1000";

let access: typeof import("./access");
let sessions: typeof import("./auth/sessions");

before(async () => {
  access = await import("./access");
  sessions = await import("./auth/sessions");
});
after(cleanup);

const newSession = () => sessions.createSession({ clientName: "Claude Code", clientVersion: "1", ip: "203.0.113.7" }).id;
const ask = (sid: string, project: string) => access.createAccessRequest(sid, { space: "pro", project, access: "read", reason: "r" });

test("a created request bumps the rev and notifies; an identical retry does not", () => {
  const seen: number[] = [];
  const off = access.onAccessChange((rev) => seen.push(rev));
  try {
    const sid = newSession();
    const before = access.currentAccessRev();
    const first = ask(sid, "feed-a");
    assert.equal(first.created, true);
    assert.equal(access.currentAccessRev(), before + 1);
    assert.deepEqual(seen, [before + 1]);
    const again = ask(sid, "feed-a");
    assert.equal(again.created, false);
    assert.equal(access.currentAccessRev(), before + 1);
    assert.equal(seen.length, 1);
  } finally {
    off();
  }
});

test("unsubscribe stops notifications", () => {
  let n = 0;
  const off = access.onAccessChange(() => n++);
  access.notifyAccessChange();
  off();
  access.notifyAccessChange();
  assert.equal(n, 1);
});

test("a throwing listener does not break createAccessRequest or other listeners", () => {
  let ok = 0;
  const off1 = access.onAccessChange(() => {
    throw new Error("boom");
  });
  const off2 = access.onAccessChange(() => ok++);
  try {
    const r = ask(newSession(), "feed-throw");
    assert.equal(r.created, true);
    assert.equal(ok, 1);
  } finally {
    off1();
    off2();
  }
});

test("approve, deny and a successful session revoke notify; a failed revoke does not", () => {
  const sid = newSession();
  const a = ask(sid, "feed-approve").request;
  const d = ask(sid, "feed-deny").request;
  let n = 0;
  const off = access.onAccessChange(() => n++);
  try {
    access.approveRequest(a.id, { actor: "t", code: a.code });
    assert.equal(n, 1);
    access.denyRequest(d.id, "t");
    assert.equal(n, 2);
    access.auditSessionRevoke("t", sid, true);
    assert.equal(n, 3);
    access.auditSessionRevoke("t", sid, false);
    assert.equal(n, 3);
  } finally {
    off();
  }
});

test("a request notifies again shortly after it expires", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const off = access.onAccessChange(() => n++);
  try {
    const { request } = ask(newSession(), "feed-expiry");
    assert.equal(n, 1);
    const ttl = Date.parse(request.expires_at) - Date.now();
    mock.timers.tick(ttl + 1000);
    assert.equal(n, 2);
  } finally {
    off();
  }
});
