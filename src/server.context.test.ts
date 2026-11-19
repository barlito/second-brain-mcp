// kb_context and kb_read_many: one call for the session start / several notes, ACL and audit per part.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type App = Awaited<ReturnType<typeof listen>>;
let db: typeof import("./db").db;
let app: App;
let baselineApp: App;
let KEY: string;
let full: string;
let noJournal: string;
let archiveOnly: string;
let nothing: string;
let readNotes: string;

const sc = (space: string, project: string, section: string) => ({ space, project, section, permission: "read" as const });
const put = (rel: string, content: string) => {
  mkdirSync(dirname(join(vault, rel)), { recursive: true });
  writeFileSync(join(vault, rel), content);
};
const ctx = (t: string, space = "pro", project = "p", extra: Record<string, unknown> = {}) =>
  callTool(app.baseUrl, t, "kb_context", { space, project, ...extra });
const many = (t: string, notes: unknown[], tail?: number) => callTool(app.baseUrl, t, "kb_read_many", { notes, ...(tail ? { tail } : {}) });
const n = (section: string, note: string, project = "p", space = "pro") => ({ space, project, section, note });
const audits = (action: string) =>
  db.prepare("SELECT space, project, section, note, result FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<Record<string, string | null>>;

before(async () => {
  ({ db } = await import("./db"));
  const { createToken } = await import("./auth/tokens");
  const keys = await import("./auth/connectorKeys");
  const { createApp, AuthFailureLimiter } = await import("./server");
  const { anonLimits } = await import("./rateLimit");
  full = createToken("full", [sc("pro", "*", "*")]).token;
  noJournal = createToken("nojournal", [sc("pro", "p", "overview"), sc("pro", "p", "decisions")]).token;
  archiveOnly = createToken("archonly", [sc("pro", "p", "archive")]).token;
  nothing = createToken("nothing", [sc("other", "*", "*")]).token;
  readNotes = createToken("readnotes", [sc("pro", "p", "notes")]).token;
  app = await listen(createApp({ vaultRoot: vault }));
  KEY = keys.createConnectorKey("test-key", "test-admin-secret").key;
  baselineApp = await listen(
    createApp({
      vaultRoot: vault,
      authLimiter: new AuthFailureLimiter(100_000),
      anonLimits: { ...anonLimits(), initPerMin: 1000, requestsPerHour: 1000, maxSessions: 1000, sessionsPerIp: 1000, ipCallsPerMin: 100000, sessionCallsPerMin: 100000 },
      sessionBaseline: [sc("meta", "*", "*")],
    }),
  );
  put("pro/p/overview/index.md", "# p\n\nthe index\n");
  put("pro/p/decisions/d1.md", "d1");
  put("pro/p/decisions/d2.md", "d2");
  put("pro/p/notes/n1.md", "line1\nline2\nline3\n");
  put("pro/p/archive/old.md", "archived");
  put("pro/p/journal/2026-09.md", "sept\n");
  put("pro/p/journal/2026-11.md", Array.from({ length: 50 }, (_, i) => `entry ${i + 1}`).join("\n") + "\n");
  put("pro/p/journal/2026-10.md", "oct\n");
  put("pro/p/journal/readme.md", "not a month");
  put("pro/empty/notes/x.md", "x");
  put("meta/m/overview/index.md", "# meta index");
});

after(async () => {
  await app.close();
  await baselineApp.close();
  cleanup();
});

test("kb_context returns index, latest journal tail and sections", async () => {
  const r = await ctx(full);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^## pro\/p\/overview\/index\n# p\n\nthe index\n/);
  assert.match(r.text, /## pro\/p\/journal\/2026-11 \(last 30 lines\)\n/);
  assert.match(r.text, /entry 50/);
  assert.match(r.text, /entry 21/);
  assert.doesNotMatch(r.text, /entry 20\b/);
  assert.doesNotMatch(r.text, /oct|sept/);
  assert.match(r.text, /Sections: decisions \(2\), journal \(4\), notes \(1\), overview \(1\)$/);
  assert.doesNotMatch(r.text, /archive/);
});

test("kb_context journal_lines", async () => {
  const r = await ctx(full, "pro", "p", { journal_lines: 2 });
  assert.match(r.text, /\(last 2 lines\)\nentry 49\nentry 50\n/);
  assert.doesNotMatch(r.text, /entry 48/);
  const bad = await ctx(full, "pro", "p", { journal_lines: 201 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /journal_lines/);
});

test("kb_context: missing index and no journal", async () => {
  const r = await ctx(full, "pro", "empty");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /## pro\/empty\/overview\/index\n\(missing: create it with kb_init_project\)/);
  assert.match(r.text, /## pro\/empty\/journal\n\(no journal yet\)/);
  assert.match(r.text, /Sections: notes \(1\)/);
});

test("kb_context: unreadable parts are omitted, sections filtered", async () => {
  const r = await ctx(noJournal);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /overview\/index/);
  assert.doesNotMatch(r.text, /journal/);
  assert.match(r.text, /Sections: decisions \(2\), overview \(1\)$/);
});

test("kb_context: nothing readable is denied without revealing existence", async () => {
  for (const [space, project] of [["pro", "p"], ["pro", "ghost"]]) {
    const r = await ctx(nothing, space, project);
    assert.equal(r.isError, true);
    assert.equal(r.text, "Permission denied.");
  }
  const onlyArchive = await ctx(archiveOnly);
  assert.equal(onlyArchive.text, "Permission denied."); // archive is never part of the context
  const bad = await ctx(full, "Pro", "p");
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid space\/project\/section\/note name/);
});

test("kb_context audits the index and the journal note read", async () => {
  await ctx(full);
  const rows = audits("kb_context");
  assert.ok(rows.some((r) => r.section === "overview" && r.note === "index" && r.result === "ok"));
  assert.ok(rows.some((r) => r.section === "journal" && r.note === "2026-11" && r.result === "ok"));
  await ctx(nothing);
  assert.ok(audits("kb_context").some((r) => r.section === "overview" && r.note === "index" && r.result === "denied"));
});

test("kb_read_many: mixed ok, denied, missing, invalid; one audit row per item", async () => {
  const before = audits("kb_read_many").length;
  const r = await many(readNotes, [n("notes", "n1"), n("decisions", "d1"), n("notes", "ghost"), n("Notes", "n1")]);
  assert.equal(r.isError, false, r.text);
  assert.equal(
    r.text,
    [
      "## pro/p/notes/n1\nline1\nline2\nline3\n",
      "## pro/p/decisions/d1\nPermission denied.",
      "## pro/p/notes/ghost\nNote not found.",
      "## pro/p/Notes/n1\nInvalid space/project/section/note name.",
    ].join("\n\n"),
  );
  const rows = audits("kb_read_many").slice(before);
  assert.deepEqual(rows.map((x) => x.result), ["ok", "denied", "error", "error"]);
  assert.equal(rows[0].note, "n1");
});

test("kb_read_many: tail and validation of the list", async () => {
  const r = await many(readNotes, [n("notes", "n1")], 1);
  assert.equal(r.text, "## pro/p/notes/n1\nline3\n");
  assert.equal((await many(readNotes, [])).isError, true);
  assert.equal((await many(readNotes, Array.from({ length: 21 }, () => n("notes", "n1")))).isError, true);
});

test("kb_read_many: archive needs read on archive", async () => {
  assert.match((await many(readNotes, [n("archive", "old")])).text, /Permission denied\./);
  assert.match((await many(archiveOnly, [n("archive", "old")])).text, /archived/);
});

test("kb_read_many: total output is capped", async () => {
  const big = "x".repeat(400 * 1024);
  for (const i of [1, 2, 3, 4]) put(`pro/p/notes/big${i}.md`, big);
  const r = await many(full, [1, 2, 3, 4].map((i) => n("notes", `big${i}`)));
  const { MAX_MANY_OUTPUT_BYTES, SKIPPED } = await import("./tools/kbReadMany");
  assert.ok(Buffer.byteLength(r.text) <= MAX_MANY_OUTPUT_BYTES);
  assert.equal(r.text.split(SKIPPED).length - 1, 2);
  assert.match(r.text, /## pro\/p\/notes\/big4\n\(skipped: output limit reached/);
});

test("baseline session reads meta with kb_context / kb_read_many but nothing else", async () => {
  const init = await fetch(`${baselineApp.baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  const sid = init.headers.get("mcp-session-id") as string;
  let id = 2;
  const call = async (name: string, args: unknown) => {
    const res = await fetch(`${baselineApp.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": KEY, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.text();
    const data = /^data: (.*)$/m.exec(body);
    return JSON.parse(data ? data[1] : body).result.content[0].text as string;
  };
  assert.match(await call("kb_context", { space: "meta", project: "m" }), /# meta index/);
  assert.match(await call("kb_read_many", { notes: [n("overview", "index", "m", "meta")] }), /# meta index/);
  assert.match(await call("kb_context", { space: "pro", project: "p" }), /Permission denied\./);
  assert.match(await call("kb_read_many", { notes: [n("overview", "index")] }), /Permission denied\./);
});
