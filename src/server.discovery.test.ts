import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type Scopes = Array<{ space: string; project: string; section: string; permission: "read" | "write" }>;
let createToken: typeof import("./auth/tokens").createToken;
let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
const tokens: Record<string, string> = {};

const r = (space: string, project: string, section: string) => ({ space, project, section, permission: "read" as const });

function put(rel: string, content: string): void {
  const f = join(vault, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
}

before(async () => {
  ({ createToken } = await import("./auth/tokens"));
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");

  put("pro/a/notes/n1.md", "Alpha NEEDLE one\nsecond line\nneedle again\n");
  put("pro/a/notes/n2.md", "nothing here\n");
  put("pro/a/journal/2026-01.md", "needle in journal\n");
  put("pro/a/archive/old.md", "needle archived\n");
  put("pro/b/notes/x.md", "needle in b\n");
  put("perso/p/notes/y.md", "needle PERSO secret\n");
  put("perso/p/notes/not-md.txt", "needle txt\n");
  put("perso/p/notes/Bad_Name.md", "needle badname\n");
  put("pro/a/notes/.hidden.md", "needle hidden\n");
  put("pro/a/notes/big.md", "needle " + "x".repeat(1024 * 1024 + 1));
  mkdirSync(join(vault, "pro/.dot/z/s"), { recursive: true });
  mkdirSync(join(vault, "Upper/z/s"), { recursive: true });
  // symlinks: file, section dir, project dir, space dir
  symlinkSync(join(vault, "perso/p/notes/y.md"), join(vault, "pro/a/notes/link.md"));
  symlinkSync(join(vault, "perso/p/notes"), join(vault, "pro/a/linkdir"));
  symlinkSync(join(vault, "perso/p"), join(vault, "pro/linkproj"));
  symlinkSync(join(vault, "perso"), join(vault, "alias"));

  const mk = (name: string, scopes: Scopes) => (tokens[name] = createToken(name, scopes).token);
  mk("exact", [r("pro", "a", "notes")]);
  mk("pro-all", [r("pro", "*", "*")]);
  mk("master", [r("*", "*", "*")]);
  mk("mixed", [r("pro", "a", "notes"), r("perso", "p", "*")]);
  mk("writer", [{ space: "pro", project: "a", section: "notes", permission: "write" }]);
  mk("malformed", [r("pro", "a", "notes")]);
  db.prepare("UPDATE scopes SET space='*', project='a' WHERE token_id=(SELECT id FROM tokens WHERE name='malformed')").run();
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const list = (tok: string, args: Record<string, unknown> = {}) => callTool(app.baseUrl, tokens[tok], "kb_list", args);
const search = (tok: string, args: Record<string, unknown>) => callTool(app.baseUrl, tokens[tok], "kb_search", args);
const names = (text: string) => text.split("\n").map((l) => l.split("\t")[0]);

test("kb_list top level derives spaces from scopes and skips dotdirs, symlinks and bad slugs", async () => {
  assert.deepEqual(names((await list("master")).text), ["perso", "pro"]);
  assert.deepEqual(names((await list("pro-all")).text), ["pro"]);
  assert.deepEqual(names((await list("exact")).text), ["pro"]);
  assert.deepEqual(names((await list("mixed")).text), ["perso", "pro"]);
  assert.deepEqual((await list("writer")).text, "(empty)");
  assert.deepEqual((await list("malformed")).text, "(empty)");
});

test("kb_list projects and sections are filtered by scope; symlinks and archive hidden", async () => {
  assert.deepEqual(names((await list("master", { space: "pro" })).text), ["a", "b"]);
  assert.deepEqual(names((await list("exact", { space: "pro" })).text), ["a"]);
  assert.deepEqual(names((await list("master", { space: "pro", project: "a" })).text), ["journal", "notes"]);
  assert.deepEqual(names((await list("exact", { space: "pro", project: "a" })).text), ["notes"]);
  assert.deepEqual(
    names((await list("master", { space: "pro", project: "a", include_archived: true })).text),
    ["archive", "journal", "notes"],
  );
  assert.deepEqual(names((await list("mixed", { space: "perso", project: "p" })).text), ["notes"]);
});

test("kb_list notes: names without .md, size and mtime; skips non-md, symlinks, dotfiles, bad slugs", async () => {
  const res = await list("exact", { space: "pro", project: "a", section: "notes" });
  assert.equal(res.isError, false);
  assert.deepEqual(names(res.text), ["big", "n1", "n2"]);
  const n1 = res.text.split("\n").find((l) => l.startsWith("n1\t"))!.split("\t");
  assert.equal(n1[1], `${"Alpha NEEDLE one\nsecond line\nneedle again\n".length} bytes`);
  assert.match(n1[2], /^\d{4}-\d\d-\d\dT/);
  const arch = await list("master", { space: "pro", project: "a", section: "archive" });
  assert.equal(arch.text, "(empty)");
  const arch2 = await list("master", { space: "pro", project: "a", section: "archive", include_archived: true });
  assert.deepEqual(names(arch2.text), ["old"]);
});

test("kb_list denies levels the token cannot read, with a generic message", async () => {
  for (const [tok, args] of [
    ["exact", { space: "perso" }],
    ["exact", { space: "pro", project: "b" }],
    ["exact", { space: "pro", project: "a", section: "journal" }],
    ["writer", { space: "pro" }],
    ["malformed", { space: "pro" }],
  ] as const) {
    assert.deepEqual(await list(tok, args), { isError: true, text: "Permission denied." }, JSON.stringify(args));
  }
  assert.equal(lastAudit(db, "token_name='exact'").result, "denied");
});

test("kb_list never follows symlinked dirs even when explicitly named", async () => {
  for (const args of [
    { space: "alias" },
    { space: "pro", project: "linkproj" },
    { space: "pro", project: "a", section: "linkdir" },
  ]) {
    const res = await list("master", args);
    assert.ok(!res.text.includes("y\t") && !res.text.includes("notes"), `${JSON.stringify(args)}: ${res.text}`);
    assert.equal(res.isError, true);
    assert.equal(res.text, "Path not allowed.");
  }
});

test("kb_list rejects invalid slugs and broken hierarchy; audits them", async () => {
  for (const args of [{ space: "*" }, { space: "Pro" }, { space: "pro", project: ".." }, { space: "pro", project: "a", section: "" }]) {
    assert.deepEqual(await list("master", args), { isError: true, text: "Invalid space/project/section/note name." });
  }
  const h = await list("master", { project: "a" });
  assert.equal(h.isError, true);
  assert.match(h.text, /requires/);
  assert.equal((await list("master", { space: "pro", section: "notes" })).isError, true);
  assert.equal(lastAudit(db, "token_name='master'").result, "error");
});

test("kb_list audit row records action, scope args and entry count", async () => {
  await list("exact", { space: "pro", project: "a" });
  const row = lastAudit(db, "token_name='exact'") as { action: string; result: string; detail: string; space: string; project: string };
  assert.equal(row.action, "kb_list");
  assert.equal(row.result, "ok");
  assert.equal(row.space, "pro");
  assert.equal(row.project, "a");
  assert.equal(row.detail, "entries=1");
});

test("kb_search finds only readable notes; no content or names outside the scope leak", async () => {
  const ex = await search("exact", { query: "needle" });
  assert.equal(ex.isError, false);
  assert.ok(ex.text.includes("pro/a/notes/n1: Alpha NEEDLE one"));
  assert.ok(ex.text.includes("pro/a/notes/n1: needle again"));
  for (const bad of ["perso", "journal", "archived", "pro/b", "txt", "hidden", "badname", "old", "big"]) {
    assert.ok(!ex.text.includes(bad), `leaked ${bad}: ${ex.text}`);
  }
  const pro = await search("pro-all", { query: "needle" });
  assert.ok(pro.text.includes("pro/b/notes/x: needle in b"));
  assert.ok(pro.text.includes("pro/a/journal/2026-01: needle in journal"));
  assert.ok(!pro.text.includes("PERSO") && !pro.text.includes("archived"));
  const mixed = await search("mixed", { query: "perso secret" });
  assert.equal(mixed.text, "perso/p/notes/y: needle PERSO secret");
  const none = await search("exact", { query: "perso secret" });
  assert.equal(none.text, "No matches.");
});

test("kb_search master: archive is hidden by default, shown with include_archived; symlinks never searched", async () => {
  const m = await search("master", { query: "needle" });
  assert.ok(!m.text.includes("archived"));
  assert.ok(!m.text.includes("link"));
  assert.equal(m.text.split("\n").filter((l) => l.includes("PERSO")).length, 1); // y only once, not via symlinks
  const a = await search("master", { query: "needle", include_archived: true });
  assert.ok(a.text.includes("pro/a/archive/old: needle archived"));
});

test("kb_search narrowing args are ACL-checked and limit the scope", async () => {
  const n = await search("master", { query: "needle", space: "pro", project: "b" });
  assert.equal(n.text, "pro/b/notes/x: needle in b");
  assert.deepEqual(await search("exact", { query: "needle", space: "perso" }), { isError: true, text: "Permission denied." });
  assert.deepEqual(await search("exact", { query: "needle", space: "pro", project: "a", section: "journal" }), {
    isError: true,
    text: "Permission denied.",
  });
  assert.equal((await search("master", { query: "needle", project: "a" })).isError, true);
  assert.deepEqual(await search("writer", { query: "needle" }), { isError: false, text: "No matches." });
});

test("kb_search query validation: 2..200 chars, plain substring (no regex)", async () => {
  assert.equal((await search("master", { query: "a" })).isError, true);
  assert.equal((await search("master", { query: " a " })).isError, true);
  assert.equal((await search("master", { query: "x".repeat(201) })).isError, true);
  assert.equal((await search("master", { query: "(a+)+$" })).text, "No matches.");
  assert.equal((await search("master", { query: "n.t" })).text, "No matches.");
});

test("kb_search caps: 3 lines per file, 200 chars per line, 50 files with truncated flag", async () => {
  put("pro/cap/notes/many.md", Array.from({ length: 6 }, (_, i) => `zzmark ${i}`).join("\n") + "\n");
  put("pro/cap/notes/long.md", "zzlong " + "y".repeat(500) + "\n");
  for (let i = 0; i < 52; i++) put(`pro/cap/files/f${String(i).padStart(2, "0")}.md`, "zzfiles\n");
  const many = await search("master", { query: "zzmark", space: "pro", project: "cap" });
  assert.equal(many.text.split("\n").length, 3);
  const long = await search("master", { query: "zzlong", space: "pro", project: "cap" });
  assert.ok(long.text.length < "pro/cap/notes/long: ".length + 210);
  const files = await search("master", { query: "zzfiles", space: "pro", project: "cap" });
  const lines = files.text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("pro/cap/files/")).length, 50);
  assert.match(lines[lines.length - 1], /truncated/);
  assert.match((lastAudit(db, "token_name='master'") as { detail: string }).detail, /hits=50 truncated/);
});

test("kb_search audit: query length and hit count, never the query text", async () => {
  await search("exact", { query: "perso secret" });
  const row = lastAudit(db, "token_name='exact'") as { action: string; result: string; detail: string };
  assert.equal(row.action, "kb_search");
  assert.equal(row.result, "ok");
  assert.equal(row.detail, "qlen=12 hits=0");
  assert.ok(!JSON.stringify(row).includes("perso secret"));
});

test("kb_list truncates at 500 entries", async () => {
  for (let i = 0; i < 502; i++) put(`pro/many/notes/n${i}.md`, "x\n");
  const res = await list("master", { space: "pro", project: "many", section: "notes" });
  const lines = res.text.split("\n");
  assert.equal(lines.length, 501);
  assert.match(lines[500], /truncated/);
});
