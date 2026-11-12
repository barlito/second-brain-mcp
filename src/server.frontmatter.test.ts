import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let baseUrl: string;
let closeMain: () => Promise<void>;
let admin: import("node:http").Server;
let adminUrl: string;
let tok: string;
let drain: () => Promise<void>;

const read = (rel: string): string => readFileSync(join(vault, rel), "utf8");
const commits = (): number => Number(git(["rev-list", "--count", "HEAD"], vault).trim());
const write = (note: string, content: string, section = "notes", token = tok) =>
  callTool(baseUrl, token, "kb_write", { space: "sp", project: "pj", section, note, content });
const today = new Date().toISOString().slice(0, 10);
const accept = (id: string) =>
  fetch(`${adminUrl}/admin/inbox/${id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  const { createAdminApp, listenAdmin } = await import("./admin");
  tok = createToken("tok-fm", [
    { space: "sp", project: "pj", section: "*", permission: "read" },
    { space: "sp", project: "pj", section: "*", permission: "write" },
  ]).token;
  ({ baseUrl, close: closeMain } = await listen(createApp({ vaultRoot: vault })));
  admin = await listenAdmin(createAdminApp(vault), 0);
  adminUrl = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
});

after(async () => {
  await drain();
  await closeMain();
  await new Promise((r) => admin.close(r));
  cleanup();
});

test("kb_write adds frontmatter with the token name as author", async () => {
  const r = await write("a", "# A\n");
  assert.equal(r.isError, false, r.text);
  assert.equal(read("sp/pj/notes/a.md"), `---\ntype: note\nauthor: tok-fm\ncreated: ${today}\nupdated: ${today}\n---\n# A\n`);
});

test("kb_write: type defaults per section and is validated", async () => {
  await write("d", "x", "decisions");
  assert.match(read("sp/pj/decisions/d.md"), /^---\ntype: decision\n/);
  const bad = await write("d2", "---\ntype: guide\n---\nx", "decisions");
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid frontmatter: in section `decisions` the type must be `decision`/);
  const bogus = await write("n2", "---\ntype: bogus\n---\nx");
  assert.match(bogus.text, /type must be one of decision, convention, note, guide, reference, gotcha/);
  const malformed = await write("n3", "---\na: [\n---\nx");
  assert.equal(malformed.isError, true);
  assert.match(malformed.text, /^Invalid frontmatter:/);
});

test("kb_write: created preserved, updated refreshed, client dates ignored, no-change makes no commit", async () => {
  await write("c", "---\nsources: [https://x.test/1]\ncreated: 1999-01-01\nauthor: evil\n---\nv1\n");
  const first = read("sp/pj/notes/c.md");
  assert.match(first, /sources: \[https:\/\/x\.test\/1\]\nauthor: tok-fm\ncreated: \d{4}-\d\d-\d\d\n/);
  // Pretend the note was created long ago.
  writeFileSync(join(vault, "sp/pj/notes/c.md"), first.replace(/created: .*/, "created: 2020-02-02"));
  git(["commit", "-qam", "backdate"], vault);
  const n = commits();
  const same = await write("c", "---\nsources: [https://x.test/1]\n---\nv1\n");
  assert.equal(same.text, "No changes (content identical).");
  assert.equal(commits(), n);
  await write("c", "---\nsources: [https://x.test/1]\n---\nv2\n");
  assert.match(read("sp/pj/notes/c.md"), new RegExp(`created: 2020-02-02\nupdated: ${today}\n---\nv2\n`));
  assert.equal(commits(), n + 1);
});

test("kb_write leaves overview, journal and archive content verbatim", async () => {
  await write("index", "# idx\n", "overview");
  await write("2026-11", "- line\n", "journal");
  assert.equal(read("sp/pj/overview/index.md"), "# idx\n");
  assert.equal(read("sp/pj/journal/2026-11.md"), "- line\n");
});

test("kb_search type filter", async () => {
  await write("g", "---\ntype: gotcha\n---\nneedle here\n");
  await write("r", "needle there\n");
  const all = await callTool(baseUrl, tok, "kb_search", { query: "needle" });
  assert.match(all.text, /notes\/g/);
  assert.match(all.text, /notes\/r/);
  const g = await callTool(baseUrl, tok, "kb_search", { query: "needle", type: "gotcha" });
  assert.match(g.text, /notes\/g/);
  assert.doesNotMatch(g.text, /notes\/r/);
  const none = await callTool(baseUrl, tok, "kb_search", { query: "needle", type: "guide" });
  assert.equal(none.text, "No matches.");
  const bad = await callTool(baseUrl, tok, "kb_search", { query: "needle", type: "bogus" });
  assert.equal(bad.isError, true);
});

test("inbox accept normalizes frontmatter with the reviewer as author", async () => {
  const p = await callTool(baseUrl, tok, "kb_propose", { space: "sp", project: "pj", section: "conventions", note: "prop", content: "# P\n", reason: "r" });
  const r = await accept(p.text);
  assert.equal(r.status, 200);
  assert.equal(read("sp/pj/conventions/prop.md"), `---\ntype: convention\nauthor: admin-cli\ncreated: ${today}\nupdated: ${today}\n---\n# P\n`);
  const bad = await callTool(baseUrl, tok, "kb_propose", { space: "sp", project: "pj", section: "decisions", note: "bad", content: "---\ntype: note\n---\nx", reason: "r" });
  const r2 = await accept(bad.text);
  assert.equal(r2.status, 422);
  assert.match(((await r2.json()) as { error: string }).error, /Invalid frontmatter/);
});

test("web create/edit: author web:<user>, created kept, no-change, 422 on bad type", async () => {
  const { createNote, editNote, sha256Hex } = await import("./admin/vault");
  const t = { space: "sp", project: "pj", section: "notes", note: "web" };
  await createNote(vault, t, "hello\n", "barlito");
  const created = read("sp/pj/notes/web.md");
  assert.match(created, /^---\ntype: note\nauthor: web:barlito\n/);
  assert.equal(await editNote(vault, t, created, sha256Hex(created), "someone"), null);
  const sha = await editNote(vault, t, created.replace("hello", "hello2"), sha256Hex(created), "someone");
  assert.ok(sha);
  assert.match(read("sp/pj/notes/web.md"), /author: web:someone\ncreated: \d{4}-\d\d-\d\d\n/);
  await assert.rejects(createNote(vault, { ...t, note: "web2" }, "---\ntype: nope\n---\nx", "barlito"), /Invalid frontmatter/);
});

test("migration: adds frontmatter from commit dates in one commit, idempotent", async () => {
  for (const s of ["notes", "decisions", "journal"]) mkdirSync(join(vault, "mg/old", s), { recursive: true });
  const commitAt = (msg: string, date: string): void => {
    git(["add", "-A"], vault);
    execFileSync("git", ["commit", "-qm", msg], { cwd: vault, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  writeFileSync(join(vault, "mg/old/notes/n.md"), "one\n");
  writeFileSync(join(vault, "mg/old/decisions/d.md"), "dec\n");
  writeFileSync(join(vault, "mg/old/journal/2026-01.md"), "- j\n");
  writeFileSync(join(vault, "mg/old/notes/has.md"), "---\ntype: guide\ncreated: 2020-01-01\n---\nkeep\n");
  writeFileSync(join(vault, "mg/old/notes/broken.md"), "---\na: [\n---\nx\n");
  writeFileSync(join(vault, "mg/old/notes/bom.md"), "\uFEFF---\nfoo: 1\n---\nbom body\n");
  writeFileSync(join(vault, "mg/old/notes/dirty.md"), "clean\n");
  commitAt("first", "2024-03-01T12:00:00Z");
  writeFileSync(join(vault, "mg/old/notes/n.md"), "one two\n");
  commitAt("second", "2025-05-05T12:00:00Z");

  writeFileSync(join(vault, "mg/old/notes/dirty.md"), "dirty edit\n");

  const before = commits();
  const run = async () => (await import("./cli/migrate")).run(["frontmatter"], adminUrl);
  const out = await run();
  assert.match(out, /Migrated 4 note\(s\) in commit [0-9a-f]{40}/);
  assert.match(out, /skipped mg\/old\/notes\/broken: Invalid frontmatter/);
  assert.equal(commits(), before + 1);
  assert.equal(read("mg/old/notes/n.md"), "---\ntype: note\nauthor: migration\ncreated: 2024-03-01\nupdated: 2025-05-05\n---\none two\n");
  assert.equal(read("mg/old/decisions/d.md"), "---\ntype: decision\nauthor: migration\ncreated: 2024-03-01\nupdated: 2024-03-01\n---\ndec\n");
  assert.equal(read("mg/old/journal/2026-01.md"), "- j\n");
  // Existing frontmatter: only the missing server keys are filled, in front.
  assert.equal(read("mg/old/notes/has.md"), "---\ntype: guide\nauthor: migration\ncreated: 2020-01-01\nupdated: 2024-03-01\n---\nkeep\n");
  // BOM + frontmatter: completed, no second block.
  assert.equal(read("mg/old/notes/bom.md").split("---\n").length, 3);
  assert.match(read("mg/old/notes/bom.md"), /^---\ntype: note\nauthor: migration\ncreated: 2024-03-01\nupdated: 2024-03-01\nfoo: 1\n---\nbom body\n$/);
  // Uncommitted changes: left alone and reported.
  assert.equal(read("mg/old/notes/dirty.md"), "dirty edit\n");
  assert.match(out, /skipped mg\/old\/notes\/dirty: uncommitted changes/);
  assert.match(await run(), /Nothing to migrate/);
  assert.equal(commits(), before + 1);
});

test("kb_write without frontmatter keeps type/sources/extras; CRLF body gets CRLF frontmatter", async () => {
  await write("inh", "---\ntype: guide\nsources: [https://a.test]\nfoo: bar\n---\nv1\n");
  await write("inh", "v2 only body\n");
  assert.match(read("sp/pj/notes/inh.md"), /^---\ntype: guide\nsources: \[https:\/\/a\.test\]\nauthor: tok-fm\n[^]*foo: bar\n---\nv2 only body\n$/);
  await write("crlf", "a\r\nb\r\n");
  assert.match(read("sp/pj/notes/crlf.md"), /^---\r\ntype: note\r\nauthor: tok-fm\r\n[^]*---\r\na\r\nb\r\n$/);
});

test("kb_search matches the body only, not the frontmatter", async () => {
  await write("fmonly", "---\nsources: [https://zebra-only.test]\n---\nnothing here\n");
  const r = await callTool(baseUrl, tok, "kb_search", { query: "zebra-only" });
  assert.equal(r.text, "No matches.");
});

test("syncBatchWrite: a failing per-item check refuses the batch before any write", async () => {
  const { syncBatchWrite } = await import("./vault/git");
  const abs = join(vault, "sp/pj/notes/batch.md");
  const n = commits();
  await assert.rejects(
    syncBatchWrite(vault, async () => [{ absolutePath: abs, content: "x", check: () => { throw new Error("nope"); } }], "batch"),
    /nope/,
  );
  assert.equal(commits(), n);
  assert.throws(() => readFileSync(abs));
});
