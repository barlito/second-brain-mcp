import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault, sleep } from "./test-support/fixtures";
import { newVaultWithRemote, otherClone } from "./test-support/git-helpers";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type Scopes = Array<{ space: string; project: string; section: string; permission: "read" | "write" }>;
let app: Awaited<ReturnType<typeof listen>>;
let idx: import("./vault/searchIndex").SearchIndex;
let idxMod: typeof import("./vault/searchIndex");
let gitMod: typeof import("./vault/git");
const tokens: Record<string, string> = {};

function put(root: string, rel: string, content: string): void {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
}

const nameHit = "---\ntype: decision\n---\nbody without the word\n";

before(async () => {
  const { createToken } = await import("./auth/tokens");
  idxMod = await import("./vault/searchIndex");
  gitMod = await import("./vault/git");
  const { createApp } = await import("./server");

  put(vault, "pro/a/notes/zeta.md", "pro-a notes zeta\nRapport sur la décision d'architecture\nautre ligne\n");
  put(vault, "pro/a/decisions/database.md", nameHit.replace("without the word", "mentions rapport once"));
  put(vault, "pro/a/notes/rapport.md", "short note\n"); // name match only
  put(vault, "pro/a/notes/both.md", "---\ntype: note\n---\nalpha beta gamma\nbeta alone\nalpha\n");
  put(vault, "pro/a/notes/split.md", "alpha here\n\nbeta there\n");
  put(vault, "pro/a/notes/alpha-only.md", "alpha only\n");
  put(vault, "pro/a/notes/phrase.md", "the quick brown fox\n");
  put(vault, "pro/a/notes/phrase2.md", "brown quick fox\n");
  put(vault, "pro/a/notes/prefix.md", "internationalisation et internal\n");
  put(vault, "pro/a/notes/frontmatter.md", "---\ntype: guide\ntitle: hiddenfm\n---\nplain\n");
  put(vault, "pro/a/archive/old.md", "archived secretword\n");
  put(vault, "pro/b/notes/hidden.md", "secretword in b\n");
  put(vault, "pro/a/notes/visible.md", "secretword in a\n");
  put(vault, "_inbox/x.md", "secretword inbox\n");
  put(vault, "pro/a/notes/big.md", "secretword " + "x".repeat(1024 * 1024 + 1));
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);

  const mk = (name: string, scopes: Scopes) => (tokens[name] = createToken(name, scopes).token);
  const rw = (section: string, permission: "read" | "write") => ({ space: "pro", project: "a", section, permission });
  mk("a-notes", [rw("notes", "read")]);
  mk("master", [{ space: "*", project: "*", section: "*", permission: "read" }]);
  mk("writer", [rw("notes", "write"), rw("archive", "write")]);
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  idxMod.dropSearchIndex(vault);
  await app.close();
  cleanup();
});

const search = (tok: string, args: Record<string, unknown>) => callTool(app.baseUrl, tokens[tok], "kb_search", args);
const files = (text: string) => [...new Set(text.split("\n").filter((l) => l.includes(": ")).map((l) => l.split(": ")[0]))];

test("before the index is ready kb_search falls back to the substring scan", async () => {
  const res = await search("master", { query: "alpha only" });
  assert.deepEqual(files(res.text), ["pro/a/notes/alpha-only"]);
  idx = idxMod.startSearchIndex(vault);
  assert.equal(idx.ready, false);
  const during = await search("master", { query: "alpha only" });
  assert.deepEqual(files(during.text), ["pro/a/notes/alpha-only"]);
  while (!idx.ready) await sleep(5);
});

test("ranking: a name match comes before a body match", async () => {
  const res = await search("master", { query: "rapport" });
  assert.equal(files(res.text)[0], "pro/a/notes/rapport");
  assert.match(res.text, /pro\/a\/notes\/rapport: \(name match\)/);
  assert.equal(files(res.text).length, 3);
});

test("terms are ANDed across lines of a note, not matched as a phrase", async () => {
  const res = await search("master", { query: "alpha beta", space: "pro", project: "a", section: "notes" });
  assert.deepEqual(files(res.text).sort(), ["pro/a/notes/both", "pro/a/notes/split"]);
  const lines = res.text.split("\n").filter((l) => l.startsWith("pro/a/notes/both"));
  assert.equal(lines.length, 3); // every line holding any term, capped at 3
});

test("quoted phrase and trailing prefix", async () => {
  assert.deepEqual(files((await search("master", { query: '"quick brown"' })).text), ["pro/a/notes/phrase"]);
  assert.deepEqual(files((await search("master", { query: "internat*" })).text), ["pro/a/notes/prefix"]);
  assert.deepEqual(files((await search("master", { query: "inter" })).text), []);
});

test("accent-insensitive in both directions, snippets still highlight the line", async () => {
  for (const q of ["decision", "décision", "DÉCISION"]) {
    const res = await search("master", { query: q });
    assert.match(res.text, /pro\/a\/notes\/zeta: Rapport sur la décision d'architecture/, q);
  }
});

test("frontmatter is not searched; type and archived filters", async () => {
  assert.equal((await search("master", { query: "hiddenfm" })).text, "No matches.");
  assert.deepEqual(files((await search("master", { query: "rapport", type: "decision" })).text), ["pro/a/decisions/database"]);
  assert.equal((await search("master", { query: "alpha", type: "guide" })).text, "No matches.");
  const def = files((await search("master", { query: "secretword" })).text);
  assert.ok(!def.includes("pro/a/archive/old"));
  assert.ok(files((await search("master", { query: "secretword", include_archived: true })).text).includes("pro/a/archive/old"));
  assert.deepEqual(files((await search("master", { query: "secretword", section: "archive", project: "a", space: "pro" })).text), ["pro/a/archive/old"]);
});

test("skips _inbox and files over 1 MB", async () => {
  assert.deepEqual(files((await search("master", { query: "secretword" })).text).sort(), ["pro/a/notes/visible", "pro/b/notes/hidden"]);
});

test("ACL: unreadable notes are invisible and not counted", async () => {
  const res = await search("a-notes", { query: "secretword" });
  assert.equal(res.text, "pro/a/notes/visible: secretword in a");
  // More unreadable than readable matches must not surface a truncation message.
  for (let i = 0; i < 60; i++) put(vault, `pro/b/notes/many-${i}.md`, "secretword secretword secretword\n");
  await idx.update(Array.from({ length: 60 }, (_, i) => `pro/b/notes/many-${i}.md`));
  assert.equal((await search("a-notes", { query: "secretword" })).text, "pro/a/notes/visible: secretword in a");
  const denied = await search("a-notes", { query: "secretword", project: "b", space: "pro" });
  assert.equal(denied.text, "Permission denied.");
});

test("query injection: FTS syntax is neutralised", async () => {
  for (const q of ['alpha"', '"alpha', "NEAR(alpha beta)", "alpha OR zzz", "-alpha", "name:alpha", "alpha AND", '(alpha', "alpha*beta", "{body}: alpha", "^alpha"]) {
    const res = await search("master", { query: q });
    assert.equal(res.isError, false, `${q}: ${res.text}`);
  }
  assert.equal((await search("master", { query: "alpha OR zzz" })).text, "No matches."); // ANDed with literal "or", "zzz"
  assert.ok(files((await search("master", { query: '"alpha' })).text).length > 0);
  assert.deepEqual(files((await search("master", { query: "NEAR(phrase" })).text), []);
  const none = await search("master", { query: '-- "" **' });
  assert.equal(none.isError, true);
  assert.match(none.text, /searchable word/);
});

test("index follows kb_write and kb_archive", async () => {
  const w = await callTool(app.baseUrl, tokens.writer, "kb_write", {
    space: "pro", project: "a", section: "notes", note: "fresh", content: "# T\nuniquefreshword here\n",
  });
  assert.equal(w.isError, false, w.text);
  assert.deepEqual(files((await search("master", { query: "uniquefreshword" })).text), ["pro/a/notes/fresh"]);
  const ar = await callTool(app.baseUrl, tokens.writer, "kb_archive", { space: "pro", project: "a", section: "notes", note: "fresh" });
  assert.equal(ar.isError, false, ar.text);
  assert.equal((await search("master", { query: "uniquefreshword" })).text, "No matches.");
  assert.deepEqual(files((await search("master", { query: "uniquefreshword", include_archived: true })).text), ["pro/a/archive/notes-fresh"]);
});

test("index follows a pull that brings remote changes (add, edit, delete)", async () => {
  const { vault: v2, remote } = newVaultWithRemote();
  const idx2 = idxMod.startSearchIndex(v2);
  while (!idx2.ready) await sleep(5);
  const hits = (q: string) => [...idx2.search(`"${q}"`, {})].map((h) => h.path);
  const other = otherClone(remote);
  put(other, "pro/a/notes/remote.md", "remoteword\n");
  put(other, "pro/a/notes/gone.md", "goneword\n");
  git(["add", "."], other);
  git(["commit", "-m", "r"], other);
  git(["push"], other);
  await gitMod.syncWrite(v2, join(v2, "pro/a/notes/local.md"), "localword\n", "local");
  await gitMod.drainWrites();
  assert.deepEqual(hits("remoteword"), ["pro/a/notes/remote"]);
  assert.deepEqual(hits("localword"), ["pro/a/notes/local"]);
  git(["pull"], other);
  git(["rm", "pro/a/notes/gone.md"], other);
  put(other, "pro/a/notes/remote.md", "changedword\n");
  git(["add", "."], other);
  git(["commit", "-m", "r2"], other);
  git(["push"], other);
  const stop = gitMod.startPeriodicSync(v2, 20);
  for (let i = 0; i < 100 && hits("changedword").length === 0; i++) await sleep(50);
  stop();
  await gitMod.drainWrites();
  assert.deepEqual(hits("changedword"), ["pro/a/notes/remote"]);
  assert.deepEqual(hits("remoteword"), []);
  assert.deepEqual(hits("goneword"), []);
  idxMod.dropSearchIndex(v2);
});

test("a commit made outside the server is indexed by the next write turn", async () => {
  put(vault, "pro/a/notes/human.md", "humancommitword\n");
  git(["add", "."], vault);
  git(["commit", "-m", "human"], vault);
  assert.equal((await search("master", { query: "humancommitword" })).text, "No matches.");
  const w = await callTool(app.baseUrl, tokens.writer, "kb_write", {
    space: "pro", project: "a", section: "notes", note: "after-human", content: "# T\nsomething\n",
  });
  assert.equal(w.isError, false, w.text);
  assert.deepEqual(files((await search("master", { query: "humancommitword" })).text), ["pro/a/notes/human"]);
});

test("a write racing the initial build is not lost", async () => {
  const { vault: v3 } = makeTempVault();
  put(v3, "pro/a/notes/old.md", "oldword\n");
  git(["add", "."], v3);
  git(["commit", "-m", "old"], v3);
  const idx3 = idxMod.startSearchIndex(v3);
  await gitMod.syncWrite(v3, join(v3, "pro/a/notes/racing.md"), "racingword\n", "racing");
  while (!idx3.ready) await sleep(5);
  const hits = (q: string) => [...idx3.search(`"${q}"`, {})].map((h) => h.path);
  assert.deepEqual(hits("racingword"), ["pro/a/notes/racing"]);
  assert.deepEqual(hits("oldword"), ["pro/a/notes/old"]);
  idxMod.dropSearchIndex(v3);
});

test("lines and the name label compare words, not raw substrings", async () => {
  put(vault, "pro/a/notes/lequipe.md", "alors L’équipe arrive\nla partie commence\nfoo bar baz\n");
  put(vault, "pro/a/notes/foo-bar.md", "unrelated text\n");
  await idx.update(["pro/a/notes/lequipe.md", "pro/a/notes/foo-bar.md"]);
  const eq = await search("master", { query: "l'équipe" });
  assert.equal(eq.text, "pro/a/notes/lequipe: alors L’équipe arrive");
  const fb = (await search("master", { query: "foo-bar" })).text;
  assert.match(fb, /pro\/a\/notes\/lequipe: foo bar baz/);
  assert.match(fb, /pro\/a\/notes\/foo-bar: \(name match\)/);
  const art = await search("master", { query: "art", section: "notes", project: "a", space: "pro" });
  assert.equal(art.text, "No matches.");
  const arts = await search("master", { query: "part*", section: "notes", project: "a", space: "pro" });
  assert.equal(arts.text, "pro/a/notes/lequipe: la partie commence");
});

test("control characters and typographic quotes in the query", async () => {
  const nul = await search("master", { query: "quick\u0000brown\u0001" });
  assert.equal(nul.isError, false, nul.text);
  assert.deepEqual(files(nul.text).sort(), ["pro/a/notes/phrase", "pro/a/notes/phrase2"]);
  assert.deepEqual(files((await search("master", { query: "«quick brown»" })).text), ["pro/a/notes/phrase"]);
  assert.deepEqual(files((await search("master", { query: "“quick brown”" })).text), ["pro/a/notes/phrase"]);
  assert.equal((await search("master", { query: "\u0000\u0000" })).isError, true);
});

test("a failing section does not break the build", async () => {
  const { vault: v4 } = makeTempVault();
  put(v4, "pro/a/notes/ok.md", "okword\n");
  put(v4, "pro/a/locked/no.md", "lockedword\n");
  chmodSync(join(v4, "pro/a/locked"), 0o000);
  try {
    const idx4 = idxMod.startSearchIndex(v4);
    while (!idx4.ready) await sleep(5);
    assert.deepEqual([...idx4.search('"okword"', {})].map((h) => h.path), ["pro/a/notes/ok"]);
    assert.deepEqual([...idx4.search('"lockedword"', {})], []);
  } finally {
    chmodSync(join(v4, "pro/a/locked"), 0o755);
    idxMod.dropSearchIndex(v4);
  }
});
