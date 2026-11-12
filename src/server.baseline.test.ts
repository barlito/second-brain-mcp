// SESSION_BASELINE_SCOPES (read access of every token-less session, no approval) and the
// "User context" (meta entry notes) appended to the instructions on initialize.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type App = Awaited<ReturnType<typeof listen>>;
let db: typeof import("./db").db;
let withBaseline: App;
let without: App;
let KEY: string;
let masterToken: string;
let baseline: typeof import("./auth/baseline");

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1.0" } },
};

async function rpc(base: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = /^data: (.*)$/m.exec(text);
  let json: any;
  try {
    json = JSON.parse(data ? data[1] : text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

let nextId = 10;
const anon = (base: string, sid?: string) => ({ "x-api-key": KEY, ...(sid ? { "mcp-session-id": sid } : {}) });

async function connect(base: string): Promise<{ sid: string; instructions: string }> {
  const r = await rpc(base, INIT, anon(base));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { sid: r.headers.get("mcp-session-id") as string, instructions: r.json.result.instructions };
}

async function call(base: string, headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, headers);
  return { isError: r.json?.result?.isError === true, text: r.json?.result?.content?.[0]?.text ?? JSON.stringify(r.json) };
}
const bearer = () => ({ Authorization: `Bearer ${masterToken}` });

before(async () => {
  ({ db } = await import("./db"));
  baseline = await import("./auth/baseline");
  const tokens = await import("./auth/tokens");
  const keys = await import("./auth/connectorKeys");
  const { createApp, AuthFailureLimiter } = await import("./server");
  const { anonLimits } = await import("./rateLimit");
  const mk = (sessionBaseline: import("./auth/types").Scope[]) =>
    listen(createApp({ vaultRoot: vault, authLimiter: new AuthFailureLimiter(100_000), anonLimits: { ...anonLimits(), initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, sessionsPerIp: 1000, ipCallsPerMin: 100000, sessionCallsPerMin: 100000 }, sessionBaseline }));
  KEY = keys.createConnectorKey("test-key", "test-admin-secret").key;
  withBaseline = await mk([{ space: "meta", project: "*", section: "*", permission: "read" }]);
  without = await mk([]);
  masterToken = tokens.createToken("master", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  const w = async (space: string, project: string, section: string, note: string, content: string) => {
    const r = await call(withBaseline.baseUrl, bearer(), "kb_write", { space, project, section, note, content });
    assert.equal(r.isError, false, r.text);
  };
  await w("meta", "profil", "overview", "index", "# profil\n\nRéponses en français, commits en anglais.");
  await w("meta", "profil", "notes", "outils", "tooling prefs");
  await w("sp", "proj-a", "notes", "n1", "secret of proj-a");
});

after(async () => {
  await withBaseline.close();
  await without.close();
  cleanup();
});

test("SESSION_BASELINE_SCOPES: unset = none; read scopes parse; write, '*' space and malformed values are refused", () => {
  assert.deepEqual(baseline.sessionBaselineScopes({}), []);
  assert.deepEqual(baseline.sessionBaselineScopes({ SESSION_BASELINE_SCOPES: " " }), []);
  assert.deepEqual(baseline.sessionBaselineScopes({ SESSION_BASELINE_SCOPES: "meta:*:*:read, idees:x:notes:read" }), [
    { space: "meta", project: "*", section: "*", permission: "read" },
    { space: "idees", project: "x", section: "notes", permission: "read" },
  ]);
  for (const bad of ["meta:*:*:write", "meta:*:*:propose", "*:*:*:read", "meta:*:notes:read", "meta:*:read", "Meta:*:*:read", "meta:../x:*:read"]) {
    assert.throws(() => baseline.sessionBaselineScopes({ SESSION_BASELINE_SCOPES: bad }), /SESSION_BASELINE_SCOPES/, bad);
  }
});

test("with a baseline, a session without any grant reads meta but nothing else, and cannot write meta", async () => {
  const base = withBaseline.baseUrl;
  const { sid } = await connect(base);
  const h = anon(base, sid);
  const r = await call(base, h, "kb_read", { space: "meta", project: "profil", section: "notes", note: "outils" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /tooling prefs/);
  const other = await call(base, h, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" });
  assert.equal(other.isError, true);
  assert.match(other.text, /Permission denied\. For another project, call kb_request_access\./);
  const write = await call(base, h, "kb_write", { space: "meta", project: "profil", section: "notes", note: "outils", content: "x" });
  assert.equal(write.isError, true);
  const spaces = await call(base, h, "kb_list", {});
  assert.equal(spaces.text.trim(), "meta");
  // The access tools still work alongside the baseline.
  const req = await call(base, h, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "work" });
  assert.equal(req.isError, false, req.text);
});

test("without a baseline, a session without grant still gets 'No access' for meta (default unchanged)", async () => {
  const base = without.baseUrl;
  const { sid, instructions } = await connect(base);
  const r = await call(base, anon(base, sid), "kb_read", { space: "meta", project: "profil", section: "notes", note: "outils" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No access for this session/);
  assert.doesNotMatch(instructions, /User context: /);
  assert.doesNotMatch(instructions, /français/);
});

test("initialize appends the readable meta entry notes as a User context, for sessions and Bearer tokens, and audits it", async () => {
  const { instructions } = await connect(withBaseline.baseUrl);
  assert.match(instructions, /kb_request_access/);
  assert.match(instructions, /User context: /);
  assert.match(instructions, /### meta\/profil\/overview\/index\n\n# profil\n\nRéponses en français, commits en anglais\./);
  assert.doesNotMatch(instructions, /tooling prefs|secret of proj-a/, "only entry notes, only meta");
  const b = await rpc(without.baseUrl, INIT, bearer());
  assert.match(b.json.result.instructions, /Réponses en français/);
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'user_context' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.ok(row, "audit row");
  assert.equal(row.result, "ok");
  assert.match(row.detail, /meta\/profil\/overview\/index/);
  // Non-initialize requests do not carry or rebuild it.
  const n = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user_context'").get() as { n: number }).n;
  await rpc(without.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user_context'").get() as { n: number }).n, n);
});

test("a token without meta read gets no User context", async () => {
  const tokens = await import("./auth/tokens");
  const t = tokens.createToken("proj-only", [{ space: "sp", project: "proj-a", section: "*", permission: "read" }]).token;
  const r = await rpc(without.baseUrl, INIT, { Authorization: `Bearer ${t}` });
  assert.doesNotMatch(r.json.result.instructions, /User context: |français/);
});

test("the User context stays within its size budget and names the entry notes it left out", async () => {
  const { USER_CONTEXT_MAX_BYTES } = await import("./userContext");
  const big = "x".repeat(3000);
  for (const p of ["z1", "z2", "z3"]) {
    const r = await call(withBaseline.baseUrl, bearer(), "kb_write", { space: "meta", project: p, section: "overview", note: "index", content: big });
    assert.equal(r.isError, false, r.text);
  }
  const { instructions } = await connect(withBaseline.baseUrl);
  const ctx = instructions.slice(instructions.indexOf("User context: "));
  assert.ok(Buffer.byteLength(ctx) < USER_CONTEXT_MAX_BYTES + 1024, `context too large: ${Buffer.byteLength(ctx)}`);
  assert.match(ctx, /### meta\/profil\/overview\/index/);
  assert.match(ctx, /Not included \(size budget\), read them with kb_read: meta\/z3\/overview\/index\./);
});
