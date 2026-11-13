import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

process.env.SPACE_LIMITS = "agents:maxNotes=3,maxNoteBytes=1000,maxProjectBytes=1500,archiveAfterDays=30";
makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
let agent: string;
let pro: string;
let drain: () => Promise<void>;
const call = (tok: string, name: string, args: Record<string, unknown>) => callTool(app.baseUrl, tok, name, args);
const w = (project: string, note: string, content: string, section = "notes", space = "agents") =>
  call(agent, "kb_write", { space, project, section, note, content });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  agent = createToken("bot", [
    { space: "agents", project: "*", section: "*", permission: "read" },
    { space: "agents", project: "*", section: "*", permission: "write" },
  ]).token;
  pro = createToken("pro", [{ space: "pro", project: "*", section: "*", permission: "write" }]).token;
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await drain();
  await app.close();
  cleanup();
});

test("parseSpaceLimits: valid specs, several spaces, empty", async () => {
  const { parseSpaceLimits } = await import("./limits");
  assert.deepEqual([...parseSpaceLimits("agents:maxNotes=30,maxNoteBytes=4096,maxProjectBytes=102400,archiveAfterDays=60")], [
    ["agents", { maxNotes: 30, maxNoteBytes: 4096, maxProjectBytes: 102400, archiveAfterDays: 60 }],
  ]);
  assert.equal(parseSpaceLimits("a:maxNotes=1;b:archiveAfterDays=2;").size, 2);
  assert.equal(parseSpaceLimits(undefined).size, 0);
  assert.equal(parseSpaceLimits("  ").size, 0);
});

test("parseSpaceLimits: malformed specs are rejected", async () => {
  const { parseSpaceLimits } = await import("./limits");
  for (const bad of [
    "agents",
    "agents:",
    "Agents:maxNotes=1",
    "agents:maxNotes",
    "agents:maxNotes=0",
    "agents:maxNotes=-1",
    "agents:maxNotes=1.5",
    "agents:maxNotes=abc",
    "agents:bogus=1",
    "agents:maxNotes=1,maxNotes=2",
    "agents:maxNotes=1;agents:maxNotes=2",
    "agents:maxNotes=1=2",
  ]) {
    assert.throws(() => parseSpaceLimits(bad), /SPACE_LIMITS/, bad);
  }
});

test("kb_write: per-note size limit, audited as error", async () => {
  const r = await w("p1", "big", "x".repeat(1001));
  assert.equal(r.isError, true);
  assert.match(r.text, /Note too large for agents: \d+ bytes \(limit 1000 per note\)/);
  assert.equal(lastAudit(db, "action = 'kb_write'").result, "error");
  assert.equal(existsSync(join(vault, "agents/p1/notes/big.md")), false);
  assert.equal((await w("p1", "ok", "x".repeat(200))).isError, false);
});

test("kb_write: note count limit with usage message; overwrite does not count twice", async () => {
  assert.equal((await w("p2", "a", "1")).isError, false);
  assert.equal((await w("p2", "b", "2")).isError, false);
  assert.equal((await w("p2", "c", "3")).isError, false);
  const r = await w("p2", "d", "4");
  assert.equal(r.isError, true);
  assert.match(r.text, /Note limit reached for agents\/p2: this write would make 4 notes \(limit 3\)\. Current usage of agents\/p2: 3 notes, \d+ bytes\. Condense notes or kb_archive old ones first\./);
  assert.equal((await w("p2", "a", "again")).isError, false); // overwrite at the cap
  // Another project in the same space has its own budget.
  assert.equal((await w("p2b", "a", "1")).isError, false);
  // Archiving frees a slot; archived notes are not counted.
  assert.equal((await call(agent, "kb_archive", { space: "agents", project: "p2", section: "notes", note: "a" })).isError, false);
  assert.equal((await w("p2", "d", "4")).isError, false);
});

test("kb_write: project bytes limit counts the new size of an overwrite, not old+new", async () => {
  // Sizes are read from disk, so the test does not depend on the frontmatter size.
  const size = (note: string): number => statSync(join(vault, "agents/p3/notes", `${note}.md`)).size;
  const s = "y".repeat(500);
  assert.equal((await w("p3", "a", s)).isError, false);
  assert.equal((await w("p3", "b", s)).isError, false);
  const oldA = size("a");
  // Overwriting a with 700 bytes grows it; old+new would be refused, the new size alone is not.
  assert.equal((await w("p3", "a", "z".repeat(700))).isError, false);
  const total = size("a") + size("b");
  assert.ok(total <= 1500 && total + oldA > 1500, `fixture sizes: total ${total}, old a ${oldA}`);
  // A new note whose body alone exceeds the remaining room is refused whatever its frontmatter.
  const r = await w("p3", "c", "z".repeat(1500 - total + 1));
  assert.equal(r.isError, true);
  assert.match(r.text, /Size limit reached for agents\/p3: this write would make \d+ bytes \(limit 1500\)\. Current usage of agents\/p3: 2 notes, \d+ bytes\./);
  assert.match(r.text, /kb_archive/);
});

test("every section but archive counts (overview/index too)", async () => {
  assert.equal((await w("p4", "index", "i", "overview")).isError, false);
  assert.equal((await w("p4", "a", "a", "decisions")).isError, false);
  assert.equal((await w("p4", "b", "b", "journal")).isError, false);
  const r = await w("p4", "c", "c", "conventions");
  assert.equal(r.isError, true);
  assert.match(r.text, /3 notes/);
});

test("an over-limit project can still be condensed but not grown", async () => {
  for (const n of ["a", "b", "c", "d"]) {
    mkdirSync(join(vault, "agents/p10/notes"), { recursive: true });
    writeFileSync(join(vault, `agents/p10/notes/${n}.md`), "x".repeat(100));
  }
  git(["add", "--", "agents/p10"], vault);
  git(["commit", "-qm", "p10"], vault);
  assert.equal((await w("p10", "a", "short")).isError, false); // shrink: allowed at 4 > 3 notes
  assert.equal((await w("p10", "e", "new")).isError, true); // grow: refused
});

test("kb_append is limited (note size and note count)", async () => {
  assert.equal((await call(agent, "kb_append", { space: "agents", project: "p5", section: "journal", note: "2026-11", entry: "first" })).isError, false);
  const big = "e".repeat(990);
  const r = await call(agent, "kb_append", { space: "agents", project: "p5", section: "journal", note: "2026-11", entry: big });
  assert.equal(r.isError, true);
  assert.match(r.text, /Note too large for agents: \d+ bytes \(limit 1000 per note\)/);
  const before = readFileSync(join(vault, "agents/p5/journal/2026-11.md"), "utf8");
  assert.doesNotMatch(before, /eeee/);
  // Count: fill to 3 notes then a 4th append-created note is refused.
  await w("p5", "n1", "1");
  await w("p5", "n2", "2");
  const r2 = await call(agent, "kb_append", { space: "agents", project: "p5", section: "journal", note: "2026-12", entry: "x" });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /Note limit reached for agents\/p5/);
});

test("kb_init_project is limited and uses the agent template in agents only", async () => {
  const r = await call(agent, "kb_init_project", { space: "agents", project: "bot-1", summary: "I fix bugs" });
  assert.equal(r.isError, false, r.text);
  const idx = readFileSync(join(vault, "agents/bot-1/overview/index.md"), "utf8");
  for (const h of ["## Role", "## Current state", "## Current task", "## Next step", "## Key notes"]) assert.ok(idx.includes(h), h);
  assert.match(idx, /^# bot-1\n\nI fix bugs\n/);
  assert.ok(Buffer.byteLength(idx) <= 3 * 1024);
  const { entryNoteTemplate } = await import("./tools/conventions");
  assert.doesNotMatch(entryNoteTemplate("x", "s", "pro"), /## Current task/);
  assert.doesNotMatch(entryNoteTemplate("x", "s"), /## Role/);
});

test("kb_init_project is refused when the project is already full", async () => {
  for (const n of ["a", "b", "c"]) assert.equal((await w("p9", n, n)).isError, false);
  const r = await call(agent, "kb_init_project", { space: "agents", project: "p9", summary: "s" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Note limit reached for agents\/p9/);
});

test("spaces without limits are unaffected", async () => {
  const r = await call(pro, "kb_write", { space: "pro", project: "p", section: "notes", note: "n", content: "x".repeat(5000) });
  assert.equal(r.isError, false);
});

test("inbox accept enforces the limits and keeps the proposal on refusal", async () => {
  const { acceptProposal } = await import("./admin/service");
  const { listInboxIds } = await import("./inbox");
  const { createToken } = await import("./auth/tokens");
  const prop = createToken("prop", [{ space: "agents", project: "p6", section: "*", permission: "propose" }]).token;
  const r = await call(prop, "kb_propose", {
    space: "agents", project: "p6", section: "notes", note: "big", content: "x".repeat(1100), reason: "r",
  });
  assert.equal(r.isError, false, r.text);
  const [id] = await listInboxIds(vault);
  await assert.rejects(acceptProposal(vault, id, false, "tester"), (e: { status?: number; message: string }) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /Note too large for agents/);
    return true;
  });
  assert.deepEqual(await listInboxIds(vault), [id]);
  assert.equal(existsSync(join(vault, "agents/p6/notes/big.md")), false);
});

test("inbox accept within limits succeeds", async () => {
  const { acceptProposal } = await import("./admin/service");
  const { listInboxIds } = await import("./inbox");
  const { createToken } = await import("./auth/tokens");
  for (const id of await listInboxIds(vault)) await (await import("./admin/service")).rejectProposal(vault, id, "tester");
  const prop = createToken("prop2", [{ space: "agents", project: "p7", section: "*", permission: "propose" }]).token;
  await call(prop, "kb_propose", { space: "agents", project: "p7", section: "notes", note: "ok", content: "small", reason: "r" });
  const [id] = await listInboxIds(vault);
  await acceptProposal(vault, id, false, "tester");
  assert.match(readFileSync(join(vault, "agents/p7/notes/ok.md"), "utf8"), /^---\n[^]*---\nsmall$/);
});

test("web admin create and edit enforce the limits (422)", async () => {
  const { createNote, editNote, sha256Hex } = await import("./admin/vault");
  const t = (note: string) => ({ space: "agents", project: "p8", section: "notes", note });
  await assert.rejects(createNote(vault, t("big"), "x".repeat(1100), "u"), (e: { status?: number; message: string }) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /Note too large/);
    return true;
  });
  await createNote(vault, t("a"), "one", "u");
  await createNote(vault, t("b"), "two", "u");
  await createNote(vault, t("c"), "three", "u");
  await assert.rejects(createNote(vault, t("d"), "four", "u"), (e: { status?: number; message: string }) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /Note limit reached for agents\/p8/);
    return true;
  });
  const raw = (n: string): string => readFileSync(join(vault, `agents/p8/notes/${n}.md`), "utf8");
  await editNote(vault, t("a"), "x".repeat(500), sha256Hex(raw("a")), "u"); // overwrite at the cap
  await assert.rejects(editNote(vault, t("a"), "x".repeat(1100), sha256Hex(raw("a")), "u"), (e: { status?: number }) => e.status === 422);
});

test("auto-archive: old notes move in one commit, fresh ones and overview/index stay", async () => {
  const { runAutoArchive } = await import("./autoArchive");
  const commitAt = (msg: string, iso: string, ...paths: string[]): void => {
    execFileSync("git", ["add", "--", ...paths], { cwd: vault });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: vault, env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
  };
  const put = (rel: string, body: string): void => {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), body);
  };
  const old = new Date(Date.now() - 90 * 86400_000).toISOString();
  put("agents/old/overview/index.md", "# old\n");
  put("agents/old/notes/stale.md", "stale\n");
  put("agents/old/journal/2026-01.md", "- line\n");
  put("agents/old/decisions/stale.md", "d\n");
  put("agents/old/archive/notes-stale.md", "already\n"); // name taken: expect suffix
  put("agents/older/notes/x.md", "x\n");
  put("pro/p/notes/stale.md", "other space, no archiveAfterDays\n");
  commitAt("old content", old, "agents/old", "agents/older", "pro/p");
  put("agents/old/notes/fresh.md", "fresh\n");
  commitAt("fresh content", new Date().toISOString(), "agents/old/notes/fresh.md");
  const before = Number(git(["rev-list", "--count", "HEAD"], vault));

  const r = await runAutoArchive(vault);
  assert.equal(r.moved, 4);
  assert.equal(Number(git(["rev-list", "--count", "HEAD"], vault)), before + 1);
  assert.match(git(["log", "-1", "--format=%s"], vault), /^auto-archive/);
  assert.ok(existsSync(join(vault, "agents/old/overview/index.md")));
  assert.ok(existsSync(join(vault, "agents/old/notes/fresh.md")));
  assert.ok(existsSync(join(vault, "pro/p/notes/stale.md")));
  assert.ok(existsSync(join(vault, "agents/old/archive/notes-stale.md")));
  assert.ok(existsSync(join(vault, "agents/old/archive/notes-stale-2.md")));
  assert.ok(existsSync(join(vault, "agents/old/archive/journal-2026-01.md")));
  assert.ok(existsSync(join(vault, "agents/old/archive/decisions-stale.md")));
  assert.ok(existsSync(join(vault, "agents/older/archive/notes-x.md")));
  assert.equal(existsSync(join(vault, "agents/old/notes/stale.md")), false);
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");

  const a = lastAudit(db, "action = 'auto_archive'");
  assert.equal(a.token_id, "system");
  assert.equal(a.result, "ok");
  assert.equal(a.git_commit, r.commitSha);
  assert.match(a.detail ?? "", /^4 note/);

  // Nothing left to do: no commit.
  const again = await runAutoArchive(vault);
  assert.equal(again.moved, 0);
  assert.equal(Number(git(["rev-list", "--count", "HEAD"], vault)), before + 1);
});

test("auto-archive treats uncommitted edits as fresh", async () => {
  const { runAutoArchive } = await import("./autoArchive");
  const old = new Date(Date.now() - 90 * 86400_000).toISOString();
  mkdirSync(join(vault, "agents/dirty/notes"), { recursive: true });
  writeFileSync(join(vault, "agents/dirty/notes/n.md"), "v1\n");
  execFileSync("git", ["add", "--", "agents/dirty"], { cwd: vault });
  execFileSync("git", ["commit", "-q", "-m", "d"], { cwd: vault, env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old } });
  writeFileSync(join(vault, "agents/dirty/notes/n.md"), "v2 being edited\n");
  assert.equal((await runAutoArchive(vault)).moved, 0);
  assert.ok(existsSync(join(vault, "agents/dirty/notes/n.md")));
  git(["checkout", "--", "agents/dirty/notes/n.md"], vault);
});

test("server instructions mention the agents space", async () => {
  const { AGENTS_SPACE_RULE } = await import("./tools/conventions");
  assert.match(AGENTS_SPACE_RULE, /agents/);
  assert.match(AGENTS_SPACE_RULE, /handover/);
  assert.match(AGENTS_SPACE_RULE, /auto-archive/);
});

test("agent preset: read+write on agents:<name>:*, extras allowed, bounded (no wildcard confirmation)", async () => {
  const { resolveScopes, confirmableWildcards, wildcardWarnings } = await import("./cli/token");
  const s = resolveScopes("agent", undefined, "bot-9");
  assert.deepEqual(s, [
    { space: "agents", project: "bot-9", section: "*", permission: "read" },
    { space: "agents", project: "bot-9", section: "*", permission: "write" },
  ]);
  assert.deepEqual(wildcardWarnings(confirmableWildcards(s, "agent", "bot-9")), []);
  const extra = resolveScopes("agent", "pro:x:notes:read", "bot-9");
  assert.equal(extra.length, 3);
  assert.deepEqual(extra[2], { space: "pro", project: "x", section: "notes", permission: "read" });
  // an extra wildcard still needs confirmation
  const wild = resolveScopes("agent", "pro:*:*:read", "bot-9");
  assert.equal(wildcardWarnings(confirmableWildcards(wild, "agent", "bot-9")).length, 1);
  assert.throws(() => resolveScopes("agent", undefined, "Bad Name"), /valid slug/);
  assert.throws(() => resolveScopes("agent", undefined), /valid slug/);
  assert.throws(() => resolveScopes("master", "a:b:c:read", "n"), /not both/);
});
