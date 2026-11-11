import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let closeMain: () => Promise<void>;
let baseUrl: string;
let admin: import("node:http").Server;
let adminUrl: string;
let tProp: string;
let tRO: string;
let tW: string;
let tMaster: string;
let drain: () => Promise<void>;

const ids = (): string[] => (existsSync(join(vault, "inbox")) ? readdirSync(join(vault, "inbox")).map((f) => f.replace(/\.md$/, "")) : []);
const commits = (): number => Number(git(["rev-list", "--count", "HEAD"], vault).trim());
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`${adminUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  const { createAdminApp, listenAdmin } = await import("./admin");
  tProp = createToken("tok-prop", [{ space: "sp", project: "pj", section: "*", permission: "propose" }]).token;
  tRO = createToken("tok-ro", [{ space: "sp", project: "pj", section: "*", permission: "read" }]).token;
  tW = createToken("tok-w", [{ space: "sp", project: "pj", section: "*", permission: "write" }]).token;
  tMaster = createToken("tok-master", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  ({ baseUrl, close: closeMain } = await listen(createApp({ vaultRoot: vault })));
  admin = await listenAdmin(createAdminApp(vault), 0);
  adminUrl = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
});

after(async () => {
  await closeMain();
  await new Promise((r) => admin.close(r));
  cleanup();
});

const propose = (token: string, over: Record<string, unknown> = {}) =>
  callTool(baseUrl, token, "kb_propose", {
    space: "sp",
    project: "pj",
    section: "notes",
    note: "idea",
    content: "# Idea\nbody\n",
    reason: "worth keeping",
    ...over,
  });

test("kb_propose: propose-only token allowed; stored as a git-tracked inbox file with frontmatter", async () => {
  const r = await propose(tProp);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  const raw = readFileSync(join(vault, "inbox", `${r.text}.md`), "utf8");
  assert.match(raw, /^---\ntarget: "sp\/pj\/notes\/idea"\nproposed_by: "tok-prop"\nreason: "worth keeping"\ncreated: "/);
  assert.ok(raw.endsWith("---\n\n# Idea\nbody\n"));
  assert.match(git(["log", "-1", "--format=%s"], vault), /^kb_propose: sp\/pj\/notes\/idea via tok-prop/);
  assert.equal(existsSync(join(vault, "sp/pj/notes/idea.md")), false);
  const a = lastAudit(db, "action = 'kb_propose'");
  assert.equal(a.result, "ok");
  await drain();
});

test("kb_propose: write token allowed, read-only denied", async () => {
  assert.equal((await propose(tW)).isError, false);
  const r = await propose(tRO);
  assert.equal(r.isError, true);
  assert.match(r.text, /Permission denied/);
  assert.equal(lastAudit(db, "action = 'kb_propose'").result, "denied");
});

test("kb_propose: propose does not grant kb_write; archive target and entry-note cap refused", async () => {
  const w = await callTool(baseUrl, tProp, "kb_write", { space: "sp", project: "pj", section: "notes", note: "x", content: "c" });
  assert.match(w.text, /Permission denied/);
  const arch = await propose(tW, { section: "archive" });
  assert.equal(arch.isError, true);
  assert.match(arch.text, /archive/);
  const big = await propose(tW, { section: "overview", note: "index", content: "x".repeat(4000) });
  assert.equal(big.isError, true);
  assert.match(big.text, /too large/);
  const bad = await propose(tW, { note: "Bad Slug" });
  assert.match(bad.text, /Invalid space/);
  assert.equal((await propose(tW, { reason: "  " })).isError, true);
});

test("space 'inbox' is rejected by every tool and hidden from list/search", async () => {
  const marker = (await propose(tW, { content: "zzuniqueneedlezz" })).text;
  assert.ok(existsSync(join(vault, "inbox", `${marker}.md`)));
  const base = { space: "inbox", project: "pj", section: "notes", note: "n" };
  const calls: Array<[string, Record<string, unknown>]> = [
    ["kb_read", base],
    ["kb_write", { ...base, content: "c" }],
    ["kb_append", { ...base, text: "c" }],
    ["kb_archive", base],
    ["kb_propose", { ...base, content: "c", reason: "r" }],
    ["kb_init_project", { space: "inbox", project: "pj", summary: "s" }],
    ["kb_list", { space: "inbox" }],
    ["kb_list", { space: "inbox", project: "pj" }],
    ["kb_search", { query: "zzuniqueneedlezz", space: "inbox" }],
  ];
  for (const [tool, args] of calls) {
    const r = await callTool(baseUrl, tMaster, tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} -> ${r.text}`);
  }
  const list = await callTool(baseUrl, tMaster, "kb_list", {});
  assert.doesNotMatch(list.text, /inbox/);
  const search = await callTool(baseUrl, tMaster, "kb_search", { query: "zzuniqueneedlezz" });
  assert.equal(search.text, "No matches.");
  assert.equal(existsSync(join(vault, "inbox", "pj")), false);
  const { createToken } = await import("./auth/tokens");
  assert.throws(() => createToken("x", [{ space: "inbox", project: "p", section: "s", permission: "read" }]), /reserved/);
  await drain();
});

test("admin listener is bound to 127.0.0.1 only", () => {
  const addr = admin.address() as AddressInfo;
  assert.equal(addr.address, "127.0.0.1");
});

test("admin: list and show", async () => {
  const id = (await propose(tProp, { note: "listed", reason: "r1" })).text;
  const list = (await (await fetch(`${adminUrl}/admin/inbox`)).json()) as { proposals: Array<Record<string, unknown>> };
  const item = list.proposals.find((p) => p.id === id)!;
  assert.equal(item.target, "sp/pj/notes/listed");
  assert.equal(item.proposed_by, "tok-prop");
  assert.equal(item.reason, "r1");
  assert.ok((item.size as number) > 0);
  const show = (await (await fetch(`${adminUrl}/admin/inbox/${id}`)).json()) as Record<string, unknown>;
  assert.equal(show.content, "# Idea\nbody\n");
  assert.equal((await fetch(`${adminUrl}/admin/inbox/20200101T000000Z-abcdef`)).status, 404);
  await drain();
});

test("admin accept: target created, inbox file gone, ONE commit; re-accept is 404", async () => {
  const id = (await propose(tProp, { note: "acc", content: "accepted body\n" })).text;
  await drain();
  const before = commits();
  const r = await post(`/admin/inbox/${id}/accept`);
  assert.equal(r.status, 200, await r.clone().text());
  await drain();
  assert.equal(readFileSync(join(vault, "sp/pj/notes/acc.md"), "utf8"), "accepted body\n");
  assert.equal(existsSync(join(vault, "inbox", `${id}.md`)), false);
  assert.equal(commits(), before + 1);
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "inbox accept: sp/pj/notes/acc (proposed by tok-prop)");
  const files = git(["show", "--name-status", "--format=", "HEAD"], vault).trim().split("\n").sort();
  assert.deepEqual(files, [`A\tsp/pj/notes/acc.md`, `D\tinbox/${id}.md`].sort());
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");
  const a = lastAudit(db, "action = 'inbox_accept'");
  assert.equal(a.result, "ok");
  assert.equal(a.token_name, "admin-cli");
  assert.equal((await post(`/admin/inbox/${id}/accept`)).status, 404);
});

test("admin accept onto an existing target is refused unless overwrite", async () => {
  await callTool(baseUrl, tW, "kb_write", { space: "sp", project: "pj", section: "notes", note: "exist", content: "old\n" });
  const id = (await propose(tProp, { note: "exist", content: "new\n" })).text;
  await drain();
  const r = await post(`/admin/inbox/${id}/accept`);
  assert.equal(r.status, 409);
  assert.equal(readFileSync(join(vault, "sp/pj/notes/exist.md"), "utf8"), "old\n");
  assert.ok(existsSync(join(vault, "inbox", `${id}.md`)));
  assert.equal(lastAudit(db, "action = 'inbox_accept'").result, "error");
  assert.equal((await post(`/admin/inbox/${id}/accept`, { overwrite: "yes" })).status, 400);
  const ok = await post(`/admin/inbox/${id}/accept`, { overwrite: true });
  assert.equal(ok.status, 200);
  await drain();
  assert.equal(readFileSync(join(vault, "sp/pj/notes/exist.md"), "utf8"), "new\n");
  assert.equal(existsSync(join(vault, "inbox", `${id}.md`)), false);
});

test("admin reject removes the file with one commit; history keeps it", async () => {
  const id = (await propose(tProp, { note: "rej" })).text;
  await drain();
  const before = commits();
  const r = await post(`/admin/inbox/${id}/reject`);
  assert.equal(r.status, 200);
  await drain();
  assert.equal(existsSync(join(vault, "inbox", `${id}.md`)), false);
  assert.equal(existsSync(join(vault, "sp/pj/notes/rej.md")), false);
  assert.equal(commits(), before + 1);
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "inbox reject: sp/pj/notes/rej (proposed by tok-prop)");
  assert.match(git(["show", `HEAD~1:inbox/${id}.md`], vault), /sp\/pj\/notes\/rej/);
  assert.equal(lastAudit(db, "action = 'inbox_reject'").result, "ok");
});

test("admin: bad id formats never touch the filesystem; foreign Host and non-JSON POST refused", async () => {
  for (const bad of ["..%2F..%2Fsecret", "x", "20200101T000000Z-ABCDEF", "20200101T000000Z-abcdef.md", "%2e%2e"]) {
    for (const [m, suffix] of [["GET", ""], ["POST", "/accept"], ["POST", "/reject"]] as const) {
      const r = await fetch(`${adminUrl}/admin/inbox/${bad}${suffix}`, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.ok(r.status === 400 || r.status === 404, `${m} ${bad}${suffix} -> ${r.status}`);
      assert.notEqual(r.status, 200);
    }
  }
  assert.equal((await fetch(`${adminUrl}/admin/inbox/x`)).status, 400);
  const wrongType = await fetch(`${adminUrl}/admin/inbox/20200101T000000Z-abcdef/reject`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 415);
  const http = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${adminUrl}/admin/inbox`, { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("concurrency: accept while a kb_write is in flight stays consistent", async () => {
  const ids2 = [] as string[];
  for (let i = 0; i < 3; i++) ids2.push((await propose(tProp, { note: `conc-${i}`, content: `c${i}\n` })).text);
  await drain();
  const rs = await Promise.all([
    ...ids2.map((id) => post(`/admin/inbox/${id}/accept`)),
    ...[0, 1, 2].map((i) => callTool(baseUrl, tW, "kb_write", { space: "sp", project: "pj", section: "notes", note: `w-${i}`, content: `w${i}\n` })),
  ]);
  for (const r of rs) assert.ok(("status" in r ? r.status === 200 : !r.isError));
  await drain();
  for (let i = 0; i < 3; i++) {
    assert.equal(readFileSync(join(vault, `sp/pj/notes/conc-${i}.md`), "utf8"), `c${i}\n`);
    assert.equal(readFileSync(join(vault, `sp/pj/notes/w-${i}.md`), "utf8"), `w${i}\n`);
  }
  for (const id of ids2) assert.equal(existsSync(join(vault, "inbox", `${id}.md`)), false);
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");
});

test("CLI against the admin listener", async () => {
  const { run } = await import("./cli/inbox");
  const id = (await propose(tProp, { note: "cli", content: "cli body\n", reason: "cli reason" })).text;
  await drain();
  assert.match(await run(["list"], adminUrl), new RegExp(`${id}  sp/pj/notes/cli  by=tok-prop`));
  const shown = await run(["show", id], adminUrl);
  assert.match(shown, /reason:\s+cli reason/);
  assert.match(shown, /cli body/);
  await assert.rejects(run(["accept", "bad id"], adminUrl), /invalid proposal id/);
  await assert.rejects(run(["accept", "20200101T000000Z-abcdef"], adminUrl), /not found/);
  assert.match(await run(["accept", id], adminUrl), /Accepted into sp\/pj\/notes\/cli/);
  const id2 = (await propose(tProp, { note: "cli2" })).text;
  await drain();
  assert.match(await run(["reject", id2], adminUrl), /Rejected/);
  await drain();
  assert.equal(readFileSync(join(vault, "sp/pj/notes/cli.md"), "utf8"), "cli body\n");
  await assert.rejects(run(["list"], "http://127.0.0.1:1"), /cannot reach the admin listener.*server running/);
  await assert.rejects(run(["bogus"], adminUrl), /usage/);
  assert.deepEqual(ids().filter((i) => i === id || i === id2), []);
});
