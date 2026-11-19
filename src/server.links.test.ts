import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type Scopes = Array<{ space: string; project: string; section: string; permission: "read" | "write" }>;
let app: Awaited<ReturnType<typeof listen>>;
let db: typeof import("./db").db;
let scanLimits: typeof import("./tools/linkScan").scanLimits;
const tokens: Record<string, string> = {};
const r = (space: string, project: string, section: string) => ({ space, project, section, permission: "read" as const });

function put(rel: string, content: string): void {
  const f = join(vault, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
}
const fm = (updated: string, body: string) => `---\ntype: note\nauthor: t\ncreated: 2020-01-01\nupdated: ${updated}\n---\n${body}\n`;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  ({ scanLimits } = await import("./tools/linkScan"));
  const { createApp } = await import("./server");

  // Project pro/a
  put(
    "pro/a/overview/index.md",
    "# a\n\n## Docs map\n- `decisions`\n  - `d1` : first\n  - `ghost` : missing\n- `notes`\n  - `listed` : ok\n  - `linked`\n- `journal` : monthly\n",
  );
  put("pro/a/decisions/d1.md", fm(today, "See [[notes/linked]] and [[broken-one]]"));
  put("pro/a/notes/listed.md", fm(today, "plain"));
  put("pro/a/notes/linked.md", fm(today, "target"));
  put("pro/a/notes/unlisted.md", fm(today, "links to [[linked]] ![[listed]]"));
  put("pro/a/notes/orphan.md", fm(today, "nobody links here"));
  put("pro/a/notes/old.md", fm("2020-01-01", "stale one"));
  put("pro/a/notes/ambig.md", fm(today, "[[twin]]"));
  put("pro/a/notes/twin.md", fm(today, "x"));
  put("pro/a/conventions/twin.md", fm(today, "x"));
  put("pro/a/journal/2026-01.md", "[[linked]] in journal\n");
  put("pro/a/archive/gone.md", "[[linked]] from archive\n");
  put("pro/a/notes/fenced.md", fm(today, "```\n[[linked]]\n```\n`[[linked]]`"));
  // Other project/space linking in; shadowing by project level
  put("pro/b/notes/ext.md", "[[pro/a/notes/orphan]] and [[twin]]\n");
  put("pro/b/notes/twin.md", "b twin\n");
  put("pro/c/notes/o.md", "[[linked]]\n"); // resolves to pro/a only if nothing closer: unique in vault
  put("perso/p/notes/secret.md", "[[pro/a/notes/listed]] secret link\n");
  // Clean project
  put("pro/clean/overview/index.md", "# c\n\n## Docs map\n- `notes`\n  - `x`\n  - `y`\n");
  put("pro/clean/notes/x.md", fm(today, "[[y]]"));
  put("pro/clean/notes/y.md", fm(today, "[[x]]"));
  // Partial ACL project
  put("pro/part/overview/index.md", "# p\n\n## Docs map\n- `notes`\n  - `v`\n");
  put("pro/part/notes/v.md", fm(today, "[[hidden-target]]"));
  put("pro/part/decisions/hidden-target.md", fm(today, "x"));

  const mk = (name: string, scopes: Scopes) => (tokens[name] = createToken(name, scopes).token);
  mk("master", [r("*", "*", "*")]);
  mk("pro-all", [r("pro", "*", "*")]);
  mk("notes-only", [r("pro", "a", "notes")]);
  mk("part", [r("pro", "part", "overview"), r("pro", "part", "notes")]);
  mk("none", [r("perso", "p", "notes")]);
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const back = (tok: string, args: Record<string, unknown>) =>
  callTool(app.baseUrl, tokens[tok], "kb_backlinks", { space: "pro", project: "a", section: "notes", note: "linked", ...args });
const lint = (tok: string, args: Record<string, unknown>) => callTool(app.baseUrl, tokens[tok], "kb_lint", { space: "pro", project: "a", ...args });

test("kb_backlinks lists linking notes, skips code and archive, resolves by level", async () => {
  const res = await back("master", {});
  assert.equal(res.isError, false, res.text);
  const files = res.text.split("\n").map((l) => l.split(": ")[0]).sort();
  assert.deepEqual(files, ["pro/a/decisions/d1", "pro/a/journal/2026-01", "pro/a/notes/unlisted", "pro/c/notes/o"]);
  assert.match(res.text, /pro\/a\/decisions\/d1: See \[\[notes\/linked\]\]/);
  assert.doesNotMatch(res.text, /fenced/);
  const withArchive = await back("master", { include_archived: true });
  assert.match(withArchive.text, /pro\/a\/archive\/gone/);
});

test("kb_backlinks: a 1-part link resolving elsewhere first is not a backlink", async () => {
  const res = await back("master", { section: "decisions", note: "d1" });
  assert.equal(res.text, "No backlinks.");
  const twin = await back("master", { note: "twin" });
  // pro/a/notes/ambig sees two twins in its project (ambiguous), pro/b ext sees its own twin.
  assert.equal(twin.text, "No backlinks.");
  const bTwin = await back("master", { project: "b", note: "twin" });
  assert.equal(bTwin.text.split("\n")[0].split(": ")[0], "pro/b/notes/ext");
});

test("kb_backlinks only scans readable sections and never reveals others", async () => {
  const orphan = await back("pro-all", { note: "listed" });
  assert.doesNotMatch(orphan.text, /perso/);
  assert.match(orphan.text, /pro\/a\/notes\/unlisted/);
  const master = await back("master", { note: "listed" });
  assert.match(master.text, /perso\/p\/notes\/secret/);
  const narrow = await back("notes-only", {});
  assert.deepEqual(narrow.text.split("\n").map((l) => l.split(": ")[0]), ["pro/a/notes/unlisted"]);
});

test("kb_backlinks: denied, not found, audited", async () => {
  const denied = await back("none", {});
  assert.equal(denied.isError, true);
  assert.equal(denied.text, "Permission denied.");
  const nf = await back("master", { note: "nope" });
  assert.equal(nf.text, "Note not found.");
  const ok = await back("master", {});
  assert.equal(ok.isError, false);
  assert.match(String(lastAudit(db, "action='kb_backlinks'")?.detail), /backlinks=4/);
});

test("kb_backlinks reports truncation", async () => {
  const old = scanLimits.maxScannedFiles;
  scanLimits.maxScannedFiles = 2;
  try {
    const res = await back("master", {});
    assert.match(res.text, /\(truncated: too many notes; results may be incomplete\)/);
  } finally {
    scanLimits.maxScannedFiles = old;
  }
});

test("kb_lint reports each category with a summary", async () => {
  const res = await lint("master", {});
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Broken links \(1\)\n- pro\/a\/decisions\/d1: \[\[broken-one\]\]/);
  assert.match(res.text, /Ambiguous links \(1\)\n- pro\/a\/notes\/ambig: \[\[twin\]\] -> .*pro\/a\/conventions\/twin.*pro\/a\/notes\/twin/);
  assert.match(res.text, /Docs map: entries pointing to missing notes \(1\)\n- `decisions\/ghost`/);
  const unlisted = res.text.split("Docs map: notes not listed")[1].split("\n\n")[0];
  assert.match(unlisted, /pro\/a\/notes\/unlisted/);
  assert.match(unlisted, /pro\/a\/notes\/old/);
  assert.doesNotMatch(unlisted, /pro\/a\/notes\/listed|pro\/a\/notes\/linked|d1/);
  const orphans = res.text.split("Orphans")[1].split("\n\n")[0];
  assert.match(orphans, /pro\/a\/notes\/ambig/); // nobody links to it
  assert.doesNotMatch(orphans, /pro\/a\/notes\/orphan/); // linked from pro/b
  assert.doesNotMatch(orphans, /notes\/linked|notes\/listed|journal|overview/);
  assert.match(res.text, /Stale notes \(1\)\n- pro\/a\/notes\/old \(updated 2020-01-01\)/);
  assert.match(res.text, /\d+ issue\(s\)\.$/m);
  assert.doesNotMatch(res.text, /not readable/);
});

test("kb_lint stale_days moves the threshold", async () => {
  const res = await lint("master", { stale_days: 3650 });
  assert.doesNotMatch(res.text, /Stale notes/);
});

test("kb_lint: a clean project has no issues", async () => {
  const res = await lint("master", { project: "clean" });
  assert.equal(res.text, "No issues.");
});

test("kb_lint with partial ACL reports only readable sections and says so", async () => {
  const res = await lint("part", { project: "part" });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /not readable by this token and were skipped/);
  // The link to the unreadable section is broken for this token, and nothing names the hidden note.
  assert.match(res.text, /Broken links \(1\)\n- pro\/part\/notes\/v: \[\[hidden-target\]\]/);
  assert.doesNotMatch(res.text, /decisions/);
});

test("kb_lint: orphans ignore incoming links from unreadable notes", async () => {
  const res = await lint("notes-only", {});
  assert.match(res.text, /pro\/a\/notes\/orphan/);
});

test("kb_lint: denied without read access and for unreadable-only projects", async () => {
  assert.equal((await lint("none", {})).text, "Permission denied.");
  const archiveOnly = callTool(app.baseUrl, tokens["pro-all"], "kb_lint", { space: "pro", project: "nonexistent" });
  assert.equal((await archiveOnly).text, "Permission denied.");
  const bad = await lint("master", { stale_days: 0 });
  assert.equal(bad.isError, true);
});
