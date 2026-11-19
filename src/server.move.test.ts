import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

type Perm = "read" | "write";
let app: Awaited<ReturnType<typeof listen>>;
let db: typeof import("./db").db;
const tokens: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);
const fm = (type: string, body: string) => `---\ntype: ${type}\nauthor: human\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n${body}\n`;
const read = (rel: string) => readFileSync(join(vault, rel), "utf8");
const commits = () => Number(git(["rev-list", "--count", "HEAD"], vault).trim());

function put(rel: string, content: string): void {
  const f = join(vault, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
}

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");

  put(
    "pro/a/overview/index.md",
    "# a\n\n## Docs map\n- `notes`\n  - `target` : the target\n  - `tosec`\n  - `nobullet`\n- `decisions`\n  - `d0`\n",
  );
  put("pro/a/notes/target.md", fm("guide", "self [[target]]"));
  put(
    "pro/a/notes/l1.md",
    fm("note", "[[target]] [[target#h|alias]] ![[target]] [[notes/target]] [[a/notes/target]] [[pro/a/notes/target]]\n| [[target\\|t]] |\n`[[target]]`\n```\n[[target]]\n```"),
  );
  put("pro/a/notes/tosec.md", fm("guide", "x"));
  put("pro/a/notes/nobullet.md", fm("note", "x"));
  put("pro/a/notes/l2.md", fm("note", "[[tosec]] [[nobullet]] [[cross]] [[ro-target]] [[dirty-target]]"));
  put("pro/a/decisions/d0.md", fm("decision", "a decision"));
  put("pro/a/decisions/dup.md", fm("decision", "x"));
  put("pro/a/notes/dupme.md", fm("note", "x"));
  put("pro/a/notes/l3.md", fm("note", "[[dupme]] [[d0]]"));
  put("pro/a/notes/cross.md", fm("note", "out [[decisions/d0]]"));
  put("pro/c/notes/cross-twin.md", "x\n");
  put("pro/a/notes/ro-target.md", fm("note", "x"));
  put("pro/ro/notes/r.md", "[[pro/a/notes/ro-target]]\n");
  put("pro/a/notes/dirty-target.md", fm("note", "x"));
  put("pro/a/notes/dirty-src.md", fm("note", "x"));
  put("pro/a/notes/big.md", fm("note", "y".repeat(400)));
  git(["add", "."], vault);
  git(["commit", "-qm", "seed"], vault);

  const sc = (space: string, project: string, section: string, permission: Perm) => ({ space, project, section, permission });
  const mk = (name: string, scopes: ReturnType<typeof sc>[]) => (tokens[name] = createToken(name, scopes).token);
  mk("mover", [sc("pro", "a", "*", "write"), sc("pro", "b", "*", "write"), sc("lim", "*", "*", "write"), sc("pro", "*", "*", "read")]);
  mk("src-only", [sc("pro", "a", "notes", "write")]);
  mk("reader", [sc("pro", "*", "*", "read")]);
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const mv = (tok: string, args: Record<string, unknown>) =>
  callTool(app.baseUrl, tokens[tok], "kb_move", { space: "pro", project: "a", section: "notes", ...args });

test("rename in place: one commit, links rewritten in every form, code untouched, docs map renamed", async () => {
  const n = commits();
  const r = await mv("mover", { note: "target", to_section: "notes", to_note: "renamed" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Moved to pro\/a\/notes\/renamed \(commit [0-9a-f]{40}\)\./);
  assert.match(r.text, /Links rewritten: 8 in 2 note\(s\)\./);
  assert.match(r.text, /Docs map of pro\/a\/overview\/index: renamed `notes\/target` to `notes\/renamed`/);
  assert.equal(commits(), n + 1);
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "kb_move: pro/a/notes/target -> pro/a/notes/renamed via mover");
  const files = git(["show", "--name-status", "--format=", "HEAD"], vault);
  assert.match(files, /^R\d+\tpro\/a\/notes\/target\.md\tpro\/a\/notes\/renamed\.md$/m);
  assert.match(files, /pro\/a\/notes\/l1\.md/);
  assert.match(files, /pro\/a\/overview\/index\.md/);
  assert.equal(existsSync(join(vault, "pro/a/notes/target.md")), false);
  assert.match(read("pro/a/notes/renamed.md"), /self \[\[renamed\]\]/);
  assert.match(read("pro/a/notes/renamed.md"), /type: guide\nauthor: human/); // type kept, frontmatter untouched
  assert.match(
    read("pro/a/notes/l1.md"),
    /\[\[renamed\]\] \[\[renamed#h\|alias\]\] !\[\[renamed\]\] \[\[notes\/renamed\]\] \[\[a\/notes\/renamed\]\] \[\[pro\/a\/notes\/renamed\]\]\n\| \[\[renamed\\\|t\]\] \|\n`\[\[target\]\]`\n```\n\[\[target\]\]\n```/,
  );
  assert.match(read("pro/a/overview/index.md"), /  - `renamed` : the target/);
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");
  assert.match(String(lastAudit(db, "action='kb_move'").detail), /-> pro\/a\/notes\/renamed links=8 notes=2/);
});

test("move across sections: type normalized, docs map entry moved under the destination bullet", async () => {
  const r = await mv("mover", { note: "tosec", to_section: "decisions", to_note: "tosec" });
  assert.equal(r.isError, false, r.text);
  const moved = read("pro/a/decisions/tosec.md");
  assert.match(moved, new RegExp(`^---\\ntype: decision\\nauthor: mover\\ncreated: 2020-01-01\\nupdated: ${today}\\n---\\nx\\n$`));
  assert.match(read("pro/a/overview/index.md"), /- `decisions`\n  - `d0`\n  - `tosec`\n/);
  assert.doesNotMatch(read("pro/a/overview/index.md"), /- `notes`[^#]*`tosec`[^#]*- `decisions`/);
  assert.match(read("pro/a/notes/l2.md"), /\[\[tosec\]\]/); // 1-part still unique in the project
  assert.match(r.text, /Links rewritten: 0 in 0 note\(s\)/);

  const d = await mv("mover", { section: "decisions", note: "d0", to_section: "notes", to_note: "d0" });
  assert.equal(d.isError, false, d.text);
  assert.match(read("pro/a/notes/d0.md"), /^---\ntype: note\nauthor: mover\n/);
  assert.match(read("pro/a/notes/cross.md"), /out \[\[notes\/d0\]\]/); // 2-part kept
  assert.match(read("pro/a/notes/l3.md"), /\[\[d0\]\]/);
});

test("a 1-part link becomes 2-part when the new name is ambiguous in the project", async () => {
  const r = await mv("mover", { note: "dupme", to_section: "conventions", to_note: "dup" });
  assert.equal(r.isError, false, r.text);
  assert.match(read("pro/a/notes/l3.md"), /\[\[conventions\/dup\]\]/);
  assert.match(read("pro/a/conventions/dup.md"), /type: convention/);
});

test("docs map without the destination bullet is reported", async () => {
  const r = await mv("mover", { note: "nobullet", to_section: "guides", to_note: "nobullet" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Docs map of pro\/a\/overview\/index: lists `notes\/nobullet` but has no `guides` bullet/);
  assert.match(read("pro/a/overview/index.md"), /  - `nobullet`/);
});

test("move across projects: incoming links get 3 parts, the moved note's own links stay valid", async () => {
  const r = await mv("mover", { note: "cross", to_project: "b", to_section: "notes", to_note: "cross-twin" });
  assert.equal(r.isError, false, r.text);
  assert.match(read("pro/a/notes/l2.md"), /\[\[b\/notes\/cross-twin\]\]/);
  // d0 moved to notes earlier ([[notes/d0]]); from pro/b a 2-part link fails, the shortest unique form is 1-part.
  assert.match(read("pro/b/notes/cross-twin.md"), /out \[\[d0\]\]/);
  assert.match(r.text, /Links rewritten: 2 in 2 note\(s\)/);
});

test("readable but not writable linking notes are reported, not changed", async () => {
  const r = await mv("mover", { note: "ro-target", to_section: "notes", to_note: "ro-moved" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Linking notes not updated \(no write access\): pro\/ro\/notes\/r/);
  assert.equal(read("pro/ro/notes/r.md"), "[[pro/a/notes/ro-target]]\n");
});

test("a linking note with uncommitted changes is reported, not swept into the commit", async () => {
  put("pro/a/notes/l2.md", read("pro/a/notes/l2.md") + "human draft\n");
  try {
    const r = await mv("mover", { note: "dirty-target", to_section: "notes", to_note: "dirty-moved" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /not updated \(uncommitted changes\): pro\/a\/notes\/l2/);
    assert.match(read("pro/a/notes/l2.md"), /\[\[dirty-target\]\][\s\S]*human draft/);
  } finally {
    git(["checkout", "--", "pro/a/notes/l2.md"], vault);
  }
});

test("refusals: permissions, archive, entry note, existing, missing, same path, uncommitted", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["reader", { note: "l3", to_section: "notes", to_note: "x" }, /^Permission denied\./],
    ["src-only", { note: "l3", to_section: "decisions", to_note: "x" }, /^Permission denied\./],
    ["src-only", { note: "l3", to_project: "b", to_section: "notes", to_note: "x" }, /^Permission denied\./],
    ["mover", { note: "l3", to_section: "archive", to_note: "x" }, /archive/],
    ["mover", { section: "archive", note: "x", to_section: "notes", to_note: "x" }, /archive/],
    ["mover", { section: "overview", note: "index", to_section: "notes", to_note: "x" }, /entry note/],
    ["mover", { note: "l3", to_section: "overview", to_note: "index" }, /entry note/],
    ["mover", { note: "l3", to_section: "notes", to_note: "l1" }, /^Destination note already exists\.$/],
    ["mover", { note: "nope", to_section: "notes", to_note: "x" }, /^Note not found\.$/],
    ["mover", { note: "l3", to_section: "notes", to_note: "l3" }, /same note/],
    ["mover", { note: "l3", to_section: "notes", to_note: "Bad Name" }, /Invalid/],
  ];
  const n = commits();
  for (const [tok, args, re] of cases) {
    const r = await mv(tok, args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  put("pro/a/notes/dirty-src.md", "edited\n");
  const dirty = await mv("mover", { note: "dirty-src", to_section: "notes", to_note: "x" });
  assert.match(dirty.text, /uncommitted changes/);
  git(["checkout", "--", "pro/a/notes/dirty-src.md"], vault);
  assert.equal(commits(), n);
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");
});

test("space limits apply to the destination; nothing is moved when refused", async () => {
  const old = process.env.SPACE_LIMITS;
  process.env.SPACE_LIMITS = "lim:maxNoteBytes=200";
  try {
    const n = commits();
    const r = await mv("mover", { note: "big", to_space: "lim", to_project: "p", to_section: "notes", to_note: "big" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Note too large for lim/);
    assert.equal(commits(), n);
    assert.ok(existsSync(join(vault, "pro/a/notes/big.md")));
    assert.equal(existsSync(join(vault, "lim/p/notes/big.md")), false);
    assert.equal(git(["status", "--porcelain"], vault).trim(), "");
  } finally {
    if (old === undefined) delete process.env.SPACE_LIMITS;
    else process.env.SPACE_LIMITS = old;
  }
});

test("the overview 3 KB cap applies to a rewritten index", async () => {
  const idx = read("pro/a/overview/index.md").replace("- `decisions`", "  - `longname`\n- `decisions`");
  put("pro/a/overview/index.md", idx + "x".repeat(3072 - Buffer.byteLength(idx)));
  put("pro/a/notes/longname.md", fm("note", "x"));
  git(["add", "."], vault);
  git(["commit", "-qm", "full index"], vault);
  const n = commits();
  const r = await mv("mover", { note: "longname", to_section: "notes", to_note: "a-much-longer-name" });
  assert.equal(r.isError, true);
  assert.match(r.text, /overview\/index is too large/);
  assert.ok(existsSync(join(vault, "pro/a/notes/longname.md")));
  assert.equal(commits(), n);
});
