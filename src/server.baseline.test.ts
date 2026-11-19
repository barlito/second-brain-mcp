// SESSION_BASELINE_SCOPES (read access of every token-less session, no approval) and the
// "User context" (meta entry notes) appended to the instructions on initialize.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("SESSION_BASELINE_SCOPES: unset = meta read, none/empty = off; read scopes parse; write, '*' space and malformed values are refused", () => {
  assert.deepEqual(baseline.sessionBaselineScopes({}), [{ space: "meta", project: "*", section: "*", permission: "read" }]);
  assert.deepEqual(baseline.sessionBaselineScopes({ SESSION_BASELINE_SCOPES: "none" }), []);
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
  // Writing tools are fenced before their own gate (no grant): the access hint, never a write.
  const target = { space: "meta", project: "profil", section: "notes", note: "outils" };
  for (const [name, args] of [
    ["kb_write", { ...target, content: "x" }],
    ["kb_append", { ...target, entry: "x" }],
    ["kb_propose", { ...target, content: "x" }],
    ["kb_archive", target],
    ["kb_init_project", { space: "meta", project: "neuf", summary: "x" }],
  ] as const) {
    const r = await call(base, h, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /No access for this session/, name);
  }
  // Read-only tools work under the baseline.
  const found = await call(base, h, "kb_search", { query: "tooling" });
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /meta\/profil\/notes\/outils/);
  assert.doesNotMatch(found.text, /proj-a/);
  const spaces = await call(base, h, "kb_list", {});
  assert.equal(spaces.text.trim(), "meta");
  // The access tools still work alongside the baseline.
  const req = await call(base, h, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "work" });
  assert.equal(req.isError, false, req.text);
});

test("with the baseline turned off, a session without grant gets 'No access' for meta", async () => {
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
  const m = /\[note meta\/profil ([0-9a-f]{8})\]\n# profil\n\nRéponses en français, commits en anglais\.\n\[end ([0-9a-f]{8})\]/.exec(instructions);
  assert.ok(m, instructions);
  assert.equal(m[1], m[2]);
  // The marker is drawn per response, so a note cannot guess it.
  assert.doesNotMatch((await connect(withBaseline.baseUrl)).instructions, new RegExp(m[1]));
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

test("the total instructions stay within the budget; left-out notes are named, never cut", async () => {
  const { INSTRUCTIONS_MAX_CHARS } = await import("./instructions");
  const big = "x".repeat(3000);
  for (const p of ["z1", "z2", "z3"]) {
    const r = await call(withBaseline.baseUrl, bearer(), "kb_write", { space: "meta", project: p, section: "overview", note: "index", content: big });
    assert.equal(r.isError, false, r.text);
  }
  const { instructions } = await connect(withBaseline.baseUrl);
  assert.ok(instructions.length <= INSTRUCTIONS_MAX_CHARS, `instructions too long: ${instructions.length}`);
  assert.match(instructions, /\[note meta\/profil /);
  assert.match(instructions, /Not included \(size\), kb_read overview\/index of: .*meta\/z3/);
  for (const run of instructions.match(/x{2,}/g) ?? []) assert.equal(run.length, 3000, "a note is never cut");
  assert.ok((instructions.match(/x{3000}/g) ?? []).length < 3, "not every big note fits");
});

test("symlinked meta projects or entry notes never reach the User context; a non-meta baseline gives none", async () => {
  const { buildUserContext } = await import("./userContext");
  writeFileSync(join(vault, "secret.md"), "outside secret\n");
  symlinkSync(join(vault, "sp", "proj-a"), join(vault, "meta", "lien"));
  mkdirSync(join(vault, "meta", "fichier-lien", "overview"), { recursive: true });
  symlinkSync(join(vault, "secret.md"), join(vault, "meta", "fichier-lien", "overview", "index.md"));
  const meta = [{ space: "meta", project: "*", section: "*", permission: "read" as const }];
  const uc = await buildUserContext(vault, meta);
  assert.ok(uc.notes.includes("meta/profil/overview/index"));
  assert.doesNotMatch(uc.text, /outside secret|lien/);
  assert.deepEqual(await buildUserContext(vault, [{ space: "idees", project: "x", section: "*", permission: "read" }]), { text: "", notes: [] });
});

test("baseline + grant: scopes add up, and a meta read the grant does not cover is signed by the session itself", async () => {
  const access = await import("./access");
  const base = withBaseline.baseUrl;
  const { sid } = await connect(base);
  const h = anon(base, sid);
  const req = await call(base, h, "kb_request_access", { space: "sp", project: "proj-a", access: "read", reason: "work" });
  access.approveRequest(/Request id: ([0-9a-f-]{36})/.exec(req.text)![1], { actor: "admin:test", scopes: [{ space: "sp", project: "proj-a", section: "*", permission: "read" }] });
  const a = await call(base, h, "kb_read", { space: "sp", project: "proj-a", section: "notes", note: "n1" });
  assert.equal(a.isError, false, a.text);
  const m = await call(base, h, "kb_read", { space: "meta", project: "profil", section: "notes", note: "outils" });
  assert.equal(m.isError, false, m.text);
  const rows = db.prepare("SELECT token_name, space FROM audit_log WHERE action = 'kb_read' ORDER BY rowid DESC LIMIT 2").all() as Array<{ token_name: string; space: string }>;
  assert.equal(rows[0].space, "meta");
  assert.equal(rows[0].token_name, "session-claude-code");
  assert.equal(rows[1].space, "sp");
  assert.match(rows[1].token_name, /^session-claude-code-sp-proj-a/);
  // Writes stay refused: the grant is read-only and the baseline never writes.
  const w = await call(base, h, "kb_write", { space: "meta", project: "profil", section: "notes", note: "outils", content: "x" });
  assert.equal(w.isError, true);
});
