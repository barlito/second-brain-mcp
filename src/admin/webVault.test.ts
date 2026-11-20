import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault, stripFm } from "../test-support/fixtures";

makeTempDb();
const { vault } = makeTempVault();

let web: typeof import("./web");
let db: typeof import("../db").db;
let logAudit: typeof import("../audit").logAudit;
let server: http.Server;
let port: number;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const SECRET = "test-secret";
const PROXY_SECRET = "p".repeat(40);
const SESSION = "session-one";
const ADMIN = {
  "remote-user": "barlito",
  "remote-groups": "admins",
  "x-sb-admin-proxy": PROXY_SECRET,
  cookie: `authelia_session=${SESSION}`,
};
const get = (path: string): Promise<Res> => request("GET", path, ADMIN);

// Nonce (and the edit form's base hash, if any) of the form posting to `action`, read from `page`.
async function form(page: string, action: string): Promise<{ nonce: string; base?: string }> {
  const body = (await get(page)).body;
  const re = new RegExp(`action="${action}"[^>]*>\\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})">(?:<input type="hidden" name="base" value="([0-9a-f]{64})">)?`);
  const m = re.exec(body);
  assert.ok(m, `form ${action} on ${page}`);
  return { nonce: m[1], base: m[2] };
}

async function post(
  path: string,
  fields: Record<string, string>,
  over: { page?: string; csrf?: string; nonce?: string; origin?: string | null } = {},
): Promise<Res> {
  const f = { ...fields };
  f.csrf = over.csrf ?? web.csrfToken(SECRET, "barlito", SESSION);
  f.nonce = over.nonce ?? (await form(over.page ?? path.replace(/\/(edit|archive)$/, ""), path)).nonce;
  const headers: Record<string, string> = { ...ADMIN, "content-type": "application/x-www-form-urlencoded" };
  const origin = over.origin === undefined ? `http://127.0.0.1:${port}` : over.origin;
  if (origin !== null) headers.origin = origin;
  return request("POST", path, headers, new URLSearchParams(f).toString());
}

const follow = async (r: Res): Promise<Res> => {
  assert.equal(r.status, 303, r.body);
  return get(String(r.headers.location));
};

function seed(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  git(["add", "."], vault);
  git(["commit", "-m", `seed ${rel}`], vault);
}
const read = (rel: string): string => readFileSync(join(vault, rel), "utf8");
const lastSubject = (): string => git(["log", "-1", "--format=%s"], vault).trim();

const NOTE = "/vault/pro/x/notes/foo";

before(async () => {
  seed("seed.md", "seed\n");
  seed("pro/x/notes/foo.md", "# Foo\n\nhello <script>alert(1)</script>\n");
  seed("pro/x/notes/other.md", "other\n");
  seed("pro/x/overview/index.md", "# x\n");
  seed("pro/y/decisions/d1.md", "d1\n");
  mkdirSync(join(vault, "_inbox"), { recursive: true });
  mkdirSync(join(vault, ".hidden", "p", "s"), { recursive: true });
  writeFileSync(join(vault, ".hidden", "p", "s", "n.md"), "x");
  web = await import("./web");
  db = (await import("../db")).db;
  ({ logAudit } = await import("../audit"));
  const { createTrustedProxy } = await import("../server");
  const app = web.createWebAdminApp({ vaultRoot: vault, trustedProxy: createTrustedProxy("127.0.0.1"), secret: SECRET, proxySecret: PROXY_SECRET });
  server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  const { drainWrites } = await import("../vault/git");
  await drainWrites();
  await new Promise((r) => server.close(r));
  cleanup();
});

test("browse: spaces -> projects -> sections -> notes, skipping _inbox and dot-dirs", async () => {
  const root = await get("/vault");
  assert.equal(root.status, 200);
  assert.match(root.body, /href="\/vault\/pro"/);
  assert.doesNotMatch(root.body, /_inbox|\.hidden/);
  assert.match((await get("/vault/pro")).body, /href="\/vault\/pro\/x"/);
  const sections = (await get("/vault/pro/x")).body;
  assert.match(sections, /href="\/vault\/pro\/x\/notes"/);
  assert.match(sections, /href="\/vault\/pro"/, "breadcrumb");
  const notes = (await get("/vault/pro/x/notes")).body;
  assert.match(notes, /href="\/vault\/pro\/x\/notes\/foo"/);
  assert.match(notes, /href="\/vault\/pro\/x\/notes\/_new"/);
  assert.equal((await get("/vault/pro/nope")).status, 404);
  assert.equal((await get("/vault/nope")).status, 404);
});

test("view: rendered is escaped, raw view, size and last commit", async () => {
  const r = await get(NOTE);
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1>Foo<\/h1>/);
  assert.doesNotMatch(r.body, /<script>alert/);
  assert.match(r.body, /last commit <a class="mono small" href="\/vault\/pro\/x\/notes\/foo\/at\/[0-9a-f]{40}\?path=/);
  assert.match(r.body, /seed pro\/x\/notes\/foo\.md/);
  const raw = await get(`${NOTE}?view=raw`);
  assert.match(raw.body, /<pre># Foo/);
  assert.match(raw.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((await get("/vault/pro/x/notes/missing")).status, 404);
});

test("edit: success commits through the write path with a web: message, audited", async () => {
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  assert.ok(f.base);
  const r = await post(`${NOTE}/edit`, { content: "# Foo\r\n\r\nedited\r\n", base: f.base }, { nonce: f.nonce });
  const page = await follow(r);
  assert.match(page.body, /Saved foo/);
  assert.equal(stripFm(read("pro/x/notes/foo.md")), "# Foo\n\nedited\n", "CRLF from the browser is normalised");
  assert.equal(lastSubject(), "web: edit pro/x/notes/foo by barlito");
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'web_note_edit' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(row.token_name, "web:barlito");
  assert.equal(row.result, "ok");
  assert.equal(row.note, "foo");
  assert.equal(row.git_commit, git(["rev-parse", "HEAD"], vault).trim());
});

test("edit: identical content -> 'no changes', no commit, audit carries no sha", async () => {
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const current = read("pro/x/notes/foo.md");
  const head = git(["rev-parse", "HEAD"], vault).trim();
  const r = await post(`${NOTE}/edit`, { content: current, base: f.base! }, { nonce: f.nonce });
  const page = await follow(r);
  assert.match(page.body, /No changes to foo \(content identical\)/);
  assert.doesNotMatch(page.body, /Commit [0-9a-f]{7}/);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'web_note_edit' ORDER BY id DESC LIMIT 1").get() as Record<string, string | null>;
  assert.equal(row.result, "ok");
  assert.equal(row.git_commit, null);
  assert.equal(row.detail, "no changes (content identical)");
});

test("edit: stale base hash -> 409, nothing overwritten", async () => {
  const a = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const b = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  assert.equal(a.base, b.base);
  assert.equal((await post(`${NOTE}/edit`, { content: "first\n", base: a.base! }, { nonce: a.nonce })).status, 303);
  const r = await post(`${NOTE}/edit`, { content: "second\n", base: b.base! }, { nonce: b.nonce });
  assert.equal(r.status, 409);
  assert.match(r.body, /note changed since you opened it/);
  assert.equal(stripFm(read("pro/x/notes/foo.md")), "first\n");
  const row = db.prepare("SELECT result FROM audit_log WHERE action = 'web_note_edit' ORDER BY id DESC LIMIT 1").get() as { result: string };
  assert.equal(row.result, "error");
});

test("edit: entry note cap -> 422 with the text kept; archive section is read-only", async () => {
  const p = "/vault/pro/x/overview/index";
  const f = await form(`${p}/edit`, `${p}/edit`);
  const r = await post(`${p}/edit`, { content: "x".repeat(4000), base: f.base! }, { nonce: f.nonce });
  assert.equal(r.status, 422);
  assert.match(r.body, /overview\/index is too large/);
  assert.equal(read("pro/x/overview/index.md"), "# x\n");
  const big = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const r2 = await post(`${NOTE}/edit`, { content: "x".repeat(513 * 1024), base: big.base! }, { nonce: big.nonce });
  assert.equal(r2.status, 422);
  assert.match(r2.body, /too large/);
  assert.equal((await get("/vault/pro/x/archive/whatever/edit")).status, 404);
});

test("edit: a secret -> 422 with the text kept, no commit, audit without the secret", async () => {
  const secret = "ghp_" + "a".repeat(36);
  const content = `# Foo\nkey ${secret}\n`;
  const before = lastSubject();
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const r = await post(`${NOTE}/edit`, { content, base: f.base! }, { nonce: f.nonce });
  assert.equal(r.status, 422);
  assert.match(r.body, /Refused: the content looks like it contains a secret \(GitHub token, line 2\)\. Remove it/);
  assert.match(r.body, /key ghp_a+/, "text kept in the form");
  assert.equal(lastSubject(), before);
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'web_note_edit' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(row.result, "error");
  assert.equal(row.detail, "secret detected: GitHub token line 2");
});

test("create: valid slug commits; invalid slug and duplicates are refused", async () => {
  const dir = "/vault/pro/x/notes";
  const ok = await post(`${dir}/_new`, { note: "fresh-note", content: "hi\r\nthere" }, { page: `${dir}/_new` });
  const page = await follow(ok);
  assert.match(page.body, /Created fresh-note/);
  assert.equal(stripFm(read("pro/x/notes/fresh-note.md")), "hi\nthere");
  assert.equal(lastSubject(), "web: create pro/x/notes/fresh-note by barlito");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'web_note_create' AND result = 'ok' AND token_name = 'web:barlito'").get() as { n: number }).n, 1);

  for (const bad of ["Bad Name", "../evil", "a/b", "-x", "x.md", "", "A".repeat(65)]) {
    const r = await post(`${dir}/_new`, { note: bad, content: "c" }, { page: `${dir}/_new` });
    assert.equal(r.status, 422, `name ${JSON.stringify(bad)}`);
    assert.match(r.body, /Invalid note name/);
  }
  assert.equal(existsSync(join(vault, "pro/x/notes/Bad Name.md")), false);
  const dup = await post(`${dir}/_new`, { note: "fresh-note", content: "again" }, { page: `${dir}/_new` });
  assert.equal(dup.status, 409);
  assert.equal(stripFm(read("pro/x/notes/fresh-note.md")), "hi\nthere");
  // archive is reserved, and a missing section is not created on the fly
  assert.equal((await get("/vault/pro/x/nosection/_new")).status, 404);
  const arch = await post("/vault/pro/x/archive/_new", { note: "n", content: "c" }, { nonce: "a".repeat(32), csrf: web.csrfToken(SECRET, "barlito", SESSION) });
  assert.equal(arch.status, 409, "nonce not taken from a real form: refused before any write");
});

test("archive: moves the note through kb_archive's implementation", async () => {
  const p = "/vault/pro/x/notes/other";
  const r = await post(`${p}/archive`, {}, { page: p });
  const page = await follow(r);
  assert.match(page.body, /Archived other to archive\/notes-other/);
  assert.equal(existsSync(join(vault, "pro/x/notes/other.md")), false);
  assert.equal(read("pro/x/archive/notes-other.md"), "other\n");
  assert.equal(lastSubject(), "web: archive pro/x/notes/other by barlito");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'web_note_archive' AND result = 'ok'").get() as { n: number }).n, 1);
  // the entry note cannot be archived
  const e = "/vault/pro/x/overview/index";
  const r2 = await follow(await post(`${e}/archive`, {}, { page: e }));
  assert.match(r2.body, /entry note .* cannot be archived/);
  // archived notes are viewable but have no edit/archive controls
  const a = await get("/vault/pro/x/archive/notes-other");
  assert.equal(a.status, 200);
  assert.doesNotMatch(a.body, /\/edit"/);
});

test("history + at-commit: lists commits, shows escaped content, rejects bad hashes", async () => {
  const h = await get(`${NOTE}/history`);
  assert.equal(h.status, 200);
  assert.match(h.body, /web: edit pro\/x\/notes\/foo by barlito/);
  assert.match(h.body, /<td>Test User<\/td>/);
  const links = [...h.body.matchAll(/href="\/vault\/pro\/x\/notes\/foo\/at\/([0-9a-f]{40})\?path=[^"]+"/g)].map((m) => m[1]);
  assert.ok(links.length >= 3);
  const oldest = links[links.length - 1];
  const at = await get(`${NOTE}/at/${oldest}`);
  assert.equal(at.status, 200);
  assert.match(at.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(at.body, /<script>alert/);
  for (const bad of ["zzzzzzz", "abc", "ABCDEF1", "a".repeat(41), "a".repeat(39), "abcdef0", "--help", "HEAD"]) {
    assert.equal((await get(`${NOTE}/at/${bad}`)).status, 400, bad);
  }
  assert.equal((await get(`${NOTE}/at/${"0".repeat(40)}`)).status, 404);
  assert.equal((await get("/vault/pro/x/notes/missing/history")).status, 404);
});

test("CSRF/Origin/nonce are enforced on the new POST routes", async () => {
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const before = read("pro/x/notes/foo.md");
  const fields = { content: "evil\n", base: f.base! };
  assert.equal((await post(`${NOTE}/edit`, fields, { nonce: f.nonce, csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post(`${NOTE}/edit`, fields, { nonce: f.nonce, origin: "http://evil.example" })).status, 403);
  assert.equal((await post(`${NOTE}/edit`, fields, { nonce: f.nonce, origin: null })).status, 403);
  assert.equal((await post(`${NOTE}/archive`, {}, { page: NOTE, csrf: "bad" })).status, 403);
  assert.equal((await post("/vault/pro/x/notes/_new", { note: "zz", content: "c" }, { page: "/vault/pro/x/notes/_new", csrf: "" })).status, 403);
  assert.equal((await post(`${NOTE}/edit`, fields, { nonce: "f".repeat(32) })).status, 409, "unknown nonce");
  assert.equal(read("pro/x/notes/foo.md"), before);
  assert.equal(existsSync(join(vault, "pro/x/notes/zz.md")), false);
});

test("path traversal and bad slugs are refused before touching the FS", async () => {
  const paths = [
    "/vault/..",
    "/vault/%2e%2e",
    "/vault/%2e%2e/x/y/z",
    "/vault/../x",
    "/vault/a%2Fb",
    "/vault/pro/x/notes/..%2F..%2Fetc",
    "/vault/pro/x/notes/%2e%2e/history",
    "/vault/pro/x/%2e%2e/foo/edit",
    "/vault/pro%2Fx/notes",
    "/vault/pro/x/notes/foo%00",
    "/vault/_inbox",
    "/vault/.hidden",
    "/vault/pro/x/notes/Foo",
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
  }
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const r = await post("/vault/pro/x/notes/%2e%2e/edit", { content: "x", base: "0".repeat(64) }, { nonce: f.nonce });
  assert.equal(r.status, 400);
  assert.equal((await get("/vault/_inbox")).status, 400);
});

test("audit viewer: newest first, 50 per page, keyset pagination, filters, validation", async () => {
  db.exec("DELETE FROM audit_log");
  for (let i = 1; i <= 120; i++) {
    logAudit({ tokenId: "t", tokenName: i % 3 === 0 ? "tok-b" : "tok-a", action: i % 2 === 0 ? "kb_write" : "kb_read", result: "ok", detail: `row <${i}>` });
  }
  const ids = (body: string): number[] => [...body.matchAll(/<tr data-id="(\d+)">/g)].map((m) => Number(m[1]));
  const p1 = await get("/audit");
  assert.equal(p1.status, 200);
  const a = ids(p1.body);
  assert.equal(a.length, 50);
  assert.deepEqual(a, [...a].sort((x, y) => y - x));
  assert.match(p1.body, /row &lt;120&gt;/);
  const next = /href="(\/audit\?before=\d+)"/.exec(p1.body);
  assert.ok(next);
  assert.equal(next[1], `/audit?before=${a[49]}`);
  const b = ids((await get(next[1])).body);
  assert.equal(b.length, 50);
  assert.ok(b[0] < a[49]);
  const c = ids((await get(`/audit?before=${b[49]}`)).body);
  assert.equal(c.length, 20);
  assert.doesNotMatch((await get(`/audit?before=${b[49]}`)).body, /Older entries/);

  const tok = await get("/audit?token=tok-b");
  assert.equal(ids(tok.body).length, 40);
  assert.doesNotMatch(tok.body, /title="tok-a"/);
  assert.doesNotMatch(tok.body, /Older entries/);
  const tokA = await get("/audit?token=tok-a");
  assert.equal(ids(tokA.body).length, 50);
  assert.match(tokA.body, /href="\/audit\?token=tok-a&amp;before=\d+"/, "filters carried by the next link");
  const both = await get("/audit?token=tok-b&action=kb_write");
  assert.equal(ids(both.body).length, 20);
  assert.equal(ids((await get("/audit?token=tok")).body).length, 0, "exact match only");
  assert.equal(ids((await get("/audit?token=&action=")).body).length, 50, "empty fields = no filter");

  for (const bad of ["before=abc", "before=-1", "before=0", "before=1e3", "action=kb%20write", "action=kb_write%27--", "action=" + "a".repeat(65), "token=" + "t".repeat(257), "token=a%00b", "before=1&before=2"]) {
    assert.equal((await get(`/audit?${bad}`)).status, 400, bad);
  }
});

test("web writes carry no inline script/style and nav links exist", async () => {
  for (const p of [NOTE, `${NOTE}/edit`, `${NOTE}/history`, "/vault", "/audit", "/vault/pro/x/notes/_new"]) {
    const body = (await get(p)).body;
    assert.match(body, /href="\/vault"/);
    assert.match(body, /href="\/audit"/);
    assert.doesNotMatch(body, /\sstyle\s*=/i);
    assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)/i);
  }
});

test("at-commit works for pre-archive history; client path is not trusted", async () => {
  seed("pro/x/notes/mover.md", "old content\n");
  const p = "/vault/pro/x/notes/mover";
  await follow(await post(`${p}/archive`, {}, { page: p }));
  const ap = "/vault/pro/x/archive/notes-mover";
  const h = await get(`${ap}/history`);
  const links = [...h.body.matchAll(/href="([^"]*\/at\/[0-9a-f]{40}\?path=[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.ok(links.length >= 2);
  const oldest = links[links.length - 1];
  assert.match(oldest, /path=pro%2Fx%2Fnotes%2Fmover\.md/);
  const at = await get(oldest);
  assert.equal(at.status, 200, at.body);
  assert.match(at.body, /old content/);
  // forged path for a real hash
  const hash = /at\/([0-9a-f]{40})/.exec(oldest)![1];
  assert.equal((await get(`${ap}/at/${hash}?path=pro%2Fx%2Fnotes%2Ffoo.md`)).status, 404);
  assert.equal((await get(`${ap}/at/${hash}?path=seed.md`)).status, 404);
});

test("symlinked note and section: view/edit/create refused, nothing written", async () => {
  symlinkSync(join(vault, "pro/x/notes/foo.md"), join(vault, "pro/x/notes/sl.md"));
  symlinkSync(join(vault, "pro/y/decisions"), join(vault, "pro/x/linked"));
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const headBefore = git(["rev-parse", "HEAD"], vault).trim();
  const fooBefore = read("pro/x/notes/foo.md");
  const d1 = read("pro/y/decisions/d1.md");
  try {
    const sl = "/vault/pro/x/notes/sl";
    assert.equal((await get(sl)).status, 404);
    assert.equal((await get(`${sl}/edit`)).status, 404);
    assert.equal((await post(`${sl}/edit`, { content: "pwn\n", base: f.base! }, { nonce: f.nonce })).status, 404);
    assert.equal((await get("/vault/pro/x/linked/d1")).status, 404);
    assert.equal((await get("/vault/pro/x/linked/_new")).status, 404);
    const n2 = await form(`${NOTE}/edit`, `${NOTE}/edit`);
    assert.equal((await post("/vault/pro/x/linked/_new", { note: "pwn", content: "x" }, { nonce: n2.nonce })).status, 404);
    const n3 = await form(`${NOTE}/edit`, `${NOTE}/edit`);
    assert.equal((await post("/vault/pro/x/linked/d1/edit", { content: "pwn\n", base: f.base! }, { nonce: n3.nonce })).status, 404);
    assert.equal(existsSync(join(vault, "pro/y/decisions/pwn.md")), false);
    assert.equal(read("pro/y/decisions/d1.md"), d1);
    assert.equal(read("pro/x/notes/foo.md"), fooBefore);
    assert.equal(git(["rev-parse", "HEAD"], vault).trim(), headBefore);
  } finally {
    rmSync(join(vault, "pro/x/notes/sl.md"));
    rmSync(join(vault, "pro/x/linked"));
  }
});

test("markdown javascript: links are not rendered as hrefs", async () => {
  seed("pro/x/notes/xss.md", "[x](javascript:alert(1)) and [y](JaVaScRiPt:alert(2))\n");
  const r = await get("/vault/pro/x/notes/xss");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /href="\s*javascript:/i);
});

test("unauthenticated large POST to /vault is refused with 401", async () => {
  const body = new URLSearchParams({ content: "x".repeat(2 * 1024 * 1024), base: "0".repeat(64) }).toString();
  const { "x-sb-admin-proxy": _p, ...noProxy } = ADMIN;
  const r = await request("POST", `${NOTE}/edit`, { ...noProxy, "content-type": "application/x-www-form-urlencoded" }, body);
  assert.equal(r.status, 401);
});

test("edit race: write lands between form load and submit -> 409 keeps the text, original base", async () => {
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const { syncWrite } = await import("../vault/git");
  await syncWrite(vault, join(vault, "pro/x/notes/foo.md"), "from mcp\n", "mcp: write");
  const r = await post(`${NOTE}/edit`, { content: "my precious edit\n", base: f.base! }, { nonce: f.nonce });
  assert.equal(r.status, 409);
  assert.match(r.body, /my precious edit/);
  assert.match(r.body, new RegExp(`name="base" value="${f.base}"`));
  assert.match(r.body, /target="_blank"/);
  assert.equal(read("pro/x/notes/foo.md"), "from mcp\n");
  const again = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const r2 = await post(`${NOTE}/edit`, { content: "my precious edit\n", base: f.base! }, { nonce: again.nonce });
  assert.equal(r2.status, 409, "resave with the original base is still refused");
});

test("edit: non-UTF-8 note is not editable; CRLF files keep CRLF", async () => {
  seed("pro/x/notes/bin.md", "ok\n");
  writeFileSync(join(vault, "pro/x/notes/bin.md"), Buffer.from([0x61, 0xff, 0x0a]));
  git(["commit", "-am", "bin"], vault);
  const b = "/vault/pro/x/notes/bin";
  assert.doesNotMatch((await get(b)).body, /\/edit"/);
  assert.equal((await get(`${b}/edit`)).status, 422);
  const f = await form(NOTE, `${NOTE}/archive`); // any valid nonce
  const r = await post(`${b}/edit`, { content: "x\n", base: "0".repeat(64) }, { nonce: f.nonce });
  assert.equal(r.status, 422);
  assert.match(r.body, /not valid UTF-8/);
  assert.deepEqual([...readFileSync(join(vault, "pro/x/notes/bin.md"))], [0x61, 0xff, 0x0a]);

  seed("pro/x/notes/crlf.md", "a\r\nb\r\n");
  const c = "/vault/pro/x/notes/crlf";
  const cf = await form(`${c}/edit`, `${c}/edit`);
  await follow(await post(`${c}/edit`, { content: "a\r\nb\r\nc\r\n", base: cf.base! }, { nonce: cf.nonce }));
  assert.equal(stripFm(read("pro/x/notes/crlf.md")), "a\r\nb\r\nc\r\n");
  assert.match(read("pro/x/notes/crlf.md"), /^---\r\ntype: note\r\nauthor: web:barlito\r\n/);
});

test("failed web writes are audited (create into a missing section)", async () => {
  const f = await form(NOTE, `${NOTE}/archive`);
  const n = (a: string): number => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND result = 'error'").get(a) as { n: number }).n;
  const c0 = n("web_note_create");
  assert.equal((await post("/vault/pro/x/nosection/_new", { note: "a", content: "c" }, { nonce: f.nonce })).status, 404);
  assert.equal(n("web_note_create"), c0 + 1);
});

test("diff + restore: escaped diff, restore commits as web restore, audit, CSRF/nonce, identical = no commit", async () => {
  const P = "/vault/pro/x/notes/revnote";
  seed("pro/x/notes/revnote.md", "line one\nold <script>alert(1)</script>\n");
  const v1 = git(["rev-parse", "HEAD"], vault).trim();
  seed("pro/x/notes/revnote.md", "line one\nnew text\n");
  const v2 = git(["rev-parse", "HEAD"], vault).trim();

  const h = await get(`${P}/history`);
  assert.match(h.body, new RegExp(`href="${P}/at/${v1}/diff"`));

  const d = await get(`${P}/at/${v1}/diff`);
  assert.equal(d.status, 200);
  // removing the version-1 line from the old side: escaped removed line
  assert.match(d.body, /<span class="d-del">-old &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
  assert.match(d.body, /<span class="d-add">\+new text<\/span>/);
  assert.doesNotMatch(d.body, /<script>alert/);
  assert.match((await get(`${P}/at/${v2}/diff`)).body, /No differences/);
  assert.equal((await get(`${P}/at/${"0".repeat(40)}/diff`)).status, 404);
  assert.equal((await get(`${P}/at/--help/diff`)).status, 400);
  assert.match((await get(`${P}/at/${v1}`)).body, /Restore this version/);

  // CSRF / Origin / nonce
  const f = await form(`${P}/at/${v1}`, `${P}/at/${v1}/restore`);
  assert.ok(f.base);
  const fields = { base: f.base! };
  assert.equal((await post(`${P}/at/${v1}/restore`, fields, { nonce: f.nonce, csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post(`${P}/at/${v1}/restore`, fields, { nonce: f.nonce, origin: null })).status, 403);
  assert.equal((await post(`${P}/at/${v1}/restore`, fields, { nonce: "f".repeat(32) })).status, 409);
  assert.equal(read("pro/x/notes/revnote.md"), "line one\nnew text\n");

  const f2 = await form(`${P}/at/${v1}`, `${P}/at/${v1}/restore`);
  const page = await follow(await post(`${P}/at/${v1}/restore`, { base: f2.base! }, { nonce: f2.nonce }));
  assert.match(page.body, /Restored revnote to /);
  assert.equal(stripFm(read("pro/x/notes/revnote.md")), "line one\nold <script>alert(1)</script>\n");
  assert.equal(lastSubject(), `web restore: pro/x/notes/revnote to ${v1.slice(0, 7)} by barlito`);
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'web_note_restore' ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(row.token_name, "web:barlito");
  assert.equal(row.result, "ok");
  assert.equal(row.git_commit, git(["rev-parse", "HEAD"], vault).trim());

  // identical: no commit
  const head = git(["rev-parse", "HEAD"], vault).trim();
  const f3 = await form(`${P}/at/${v1}`, `${P}/at/${v1}/restore`);
  const again = await follow(await post(`${P}/at/${v1}/restore`, { base: f3.base! }, { nonce: f3.nonce }));
  assert.match(again.body, /No changes to revnote/);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);
  const row2 = db.prepare("SELECT * FROM audit_log WHERE action = 'web_note_restore' ORDER BY id DESC LIMIT 1").get() as Record<string, string | null>;
  assert.equal(row2.git_commit, null);
});

test("restore: stale base -> 409; note absent at that commit and non-UTF-8 blob refused", async () => {
  const P = "/vault/pro/x/notes/revstale";
  seed("pro/x/notes/revstale.md", "v1\n");
  const v1 = git(["rev-parse", "HEAD"], vault).trim();
  seed("pro/x/notes/revstale.md", "v2\n");
  const f = await form(`${P}/at/${v1}`, `${P}/at/${v1}/restore`);
  seed("pro/x/notes/revstale.md", "v3 changed meanwhile\n");
  const head = git(["rev-parse", "HEAD"], vault).trim();
  const r = await post(`${P}/at/${v1}/restore`, { base: f.base! }, { nonce: f.nonce });
  assert.equal(r.status, 409);
  assert.match(r.body, /note changed since you opened it/);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);

  // a commit where the note did not exist (the seed.md commit)
  const before = git(["log", "--format=%H", "--", "seed.md"], vault).trim().split("\n")[0];
  const g = await form(`${P}`, `${P}/archive`);
  const cur = await form(`${P}/at/${v1}`, `${P}/at/${v1}/restore`);
  const miss = await post(`${P}/at/${before}/restore`, { base: cur.base! }, { nonce: g.nonce });
  assert.equal(miss.status, 303);
  assert.match((await follow(miss)).body, /not found at this commit/);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);
  const row = db.prepare("SELECT result FROM audit_log WHERE action = 'web_note_restore' ORDER BY id DESC LIMIT 1").get() as { result: string };
  assert.equal(row.result, "error");

  // blob that is not valid UTF-8
  writeFileSync(join(vault, "pro/x/notes/revbin.md"), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
  git(["add", "."], vault);
  git(["commit", "-m", "binary-ish"], vault);
  const b1 = git(["rev-parse", "HEAD"], vault).trim();
  seed("pro/x/notes/revbin.md", "clean\n");
  const B = "/vault/pro/x/notes/revbin";
  const fb = await form(`${B}/at/${b1}`, `${B}/at/${b1}/restore`);
  const rb = await post(`${B}/at/${b1}/restore`, { base: fb.base! }, { nonce: fb.nonce });
  assert.match((await follow(rb)).body, /not valid UTF-8/);
  assert.equal(read("pro/x/notes/revbin.md"), "clean\n");
});

test("diff page says so for a binary change", async () => {
  writeFileSync(join(vault, "pro/x/notes/revnul.md"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
  git(["add", "."], vault);
  git(["commit", "-m", "nul"], vault);
  const n1 = git(["rev-parse", "HEAD"], vault).trim();
  seed("pro/x/notes/revnul.md", "text now\n");
  const d = await get(`/vault/pro/x/notes/revnul/at/${n1}/diff`);
  assert.equal(d.status, 200);
  assert.match(d.body, /Binary or non-text change/);
  assert.doesNotMatch(d.body, /No differences/);
});

test("restore is not offered for archived notes and refused if posted", async () => {
  seed("pro/x/archive/old-one.md", "a\n");
  const h = git(["rev-parse", "HEAD"], vault).trim();
  const P = "/vault/pro/x/archive/old-one";
  assert.doesNotMatch((await get(`${P}/at/${h}`)).body, /Restore this version/);
  const head = git(["rev-parse", "HEAD"], vault).trim();
  const f = await form(`${NOTE}/edit`, `${NOTE}/edit`);
  const r = await post(`${P}/at/${h}/restore`, { base: "0".repeat(64) }, { nonce: f.nonce });
  await follow(r);
  assert.equal(git(["rev-parse", "HEAD"], vault).trim(), head);
});
