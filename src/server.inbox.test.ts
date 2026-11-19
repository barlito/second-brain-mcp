import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault, stripFm } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";
import { inboxPath, serializeProposal } from "./inbox";

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
let lc: import("./server").Lifecycle;

const ids = (): string[] => (existsSync(join(vault, "_inbox")) ? readdirSync(join(vault, "_inbox")).map((f) => f.replace(/\.md$/, "")) : []);
const commits = (): number => Number(git(["rev-list", "--count", "HEAD"], vault).trim());
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`${adminUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  const { createAdminApp, listenAdmin } = await import("./admin");
  lc = new (await import("./server")).Lifecycle();
  tProp = createToken("tok-prop", [{ space: "sp", project: "pj", section: "*", permission: "propose" }]).token;
  tRO = createToken("tok-ro", [{ space: "sp", project: "pj", section: "*", permission: "read" }]).token;
  tW = createToken("tok-w", [{ space: "sp", project: "pj", section: "*", permission: "write" }]).token;
  tMaster = createToken("tok-master", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  ({ baseUrl, close: closeMain } = await listen(createApp({ vaultRoot: vault })));
  admin = await listenAdmin(createAdminApp(vault, lc), 0);
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
  const raw = readFileSync(join(vault, "_inbox", `${r.text}.md`), "utf8");
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

test("space \"_inbox\" is rejected by every tool and hidden from list/search", async () => {
  const marker = (await propose(tW, { content: "zzuniqueneedlezz" })).text;
  assert.ok(existsSync(join(vault, "_inbox", `${marker}.md`)));
  const base = { space: "_inbox", project: "pj", section: "notes", note: "n" };
  const calls: Array<[string, Record<string, unknown>]> = [
    ["kb_read", base],
    ["kb_write", { ...base, content: "c" }],
    ["kb_append", { ...base, text: "c" }],
    ["kb_archive", base],
    ["kb_propose", { ...base, content: "c", reason: "r" }],
    ["kb_init_project", { space: "_inbox", project: "pj", summary: "s" }],
    ["kb_list", { space: "_inbox" }],
    ["kb_list", { space: "_inbox", project: "pj" }],
    ["kb_search", { query: "zzuniqueneedlezz", space: "_inbox" }],
  ];
  for (const [tool, args] of calls) {
    const r = await callTool(baseUrl, tMaster, tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} -> ${r.text}`);
  }
  const list = await callTool(baseUrl, tMaster, "kb_list", {});
  assert.doesNotMatch(list.text, /inbox/);
  const search = await callTool(baseUrl, tMaster, "kb_search", { query: "zzuniqueneedlezz" });
  assert.equal(search.text, "No matches.");
  assert.equal(existsSync(join(vault, "_inbox", "pj")), false);
  const { createToken } = await import("./auth/tokens");
  assert.throws(() => createToken("x", [{ space: "_inbox", project: "p", section: "s", permission: "read" }]), /invalid/);
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
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/acc.md"), "utf8")), "accepted body\n");
  assert.equal(existsSync(join(vault, "_inbox", `${id}.md`)), false);
  assert.equal(commits(), before + 1);
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "inbox accept: sp/pj/notes/acc (proposed by tok-prop)");
  const files = git(["show", "--name-status", "--format=", "HEAD"], vault).trim().split("\n").sort();
  assert.deepEqual(files, [`A\tsp/pj/notes/acc.md`, `D\t_inbox/${id}.md`].sort());
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
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/exist.md"), "utf8")), "old\n");
  assert.ok(existsSync(join(vault, "_inbox", `${id}.md`)));
  assert.equal(lastAudit(db, "action = 'inbox_accept'").result, "error");
  assert.equal((await post(`/admin/inbox/${id}/accept`, { overwrite: "yes" })).status, 400);
  const ok = await post(`/admin/inbox/${id}/accept`, { overwrite: true });
  assert.equal(ok.status, 200);
  await drain();
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/exist.md"), "utf8")), "new\n");
  assert.equal(existsSync(join(vault, "_inbox", `${id}.md`)), false);
});

test("admin reject removes the file with one commit; history keeps it", async () => {
  const id = (await propose(tProp, { note: "rej" })).text;
  await drain();
  const before = commits();
  const r = await post(`/admin/inbox/${id}/reject`);
  assert.equal(r.status, 200);
  await drain();
  assert.equal(existsSync(join(vault, "_inbox", `${id}.md`)), false);
  assert.equal(existsSync(join(vault, "sp/pj/notes/rej.md")), false);
  assert.equal(commits(), before + 1);
  assert.equal(git(["log", "-1", "--format=%s"], vault).trim(), "inbox reject: sp/pj/notes/rej (proposed by tok-prop)");
  assert.match(git(["show", `HEAD~1:_inbox/${id}.md`], vault), /sp\/pj\/notes\/rej/);
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
    assert.equal(stripFm(readFileSync(join(vault, `sp/pj/notes/conc-${i}.md`), "utf8")), `c${i}\n`);
    assert.equal(stripFm(readFileSync(join(vault, `sp/pj/notes/w-${i}.md`), "utf8")), `w${i}\n`);
  }
  for (const id of ids2) assert.equal(existsSync(join(vault, "_inbox", `${id}.md`)), false);
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
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/cli.md"), "utf8")), "cli body\n");
  await assert.rejects(run(["list"], "http://127.0.0.1:1"), /cannot reach the admin listener.*server running/);
  await assert.rejects(run(["bogus"], adminUrl), /usage/);
  assert.deepEqual(ids().filter((i) => i === id || i === id2), []);
});

// ---- review-fix tests -------------------------------------------------------

const mid = (n: number): string => `20200101T000000Z-${n.toString(16).padStart(6, "0")}`;
const manual = (id: string, target: string, content: string): void => {
  mkdirSync(join(vault, "_inbox"), { recursive: true });
  writeFileSync(
    join(vault, "_inbox", `${id}.md`),
    serializeProposal({ target, proposedBy: "hand", reason: "r", created: "2020-01-01T00:00:00.000Z", content }),
  );
};
const head = (): string => git(["rev-parse", "HEAD"], vault).trim();

test("a user space literally named 'inbox' works normally", async () => {
  const w = await callTool(baseUrl, tMaster, "kb_write", { space: "inbox", project: "pj", section: "notes", note: "n", content: "user inbox\n" });
  assert.equal(w.isError, false, w.text);
  const r = await callTool(baseUrl, tMaster, "kb_read", { space: "inbox", project: "pj", section: "notes", note: "n" });
  assert.match(r.text, /user inbox/);
  const list = await callTool(baseUrl, tMaster, "kb_list", {});
  assert.match(list.text, /\binbox\b/);
  assert.doesNotMatch(list.text, /_inbox/);
  const s = await callTool(baseUrl, tMaster, "kb_search", { query: "user inbox" });
  assert.match(s.text, /inbox\/pj\/notes\/n/);
  await drain();
});

test("kb_propose enforces a UTF-8 byte cap on the final file", async () => {
  const over = await propose(tW, { note: "bytes-over", content: "é".repeat(294_950) });
  assert.equal(over.isError, true);
  assert.match(over.text, /too large/);
  const ok = await propose(tW, { note: "bytes-ok", content: "é".repeat(294_700) });
  assert.equal(ok.isError, false, ok.text);
  await drain();
  const shown = await fetch(`${adminUrl}/admin/inbox/${ok.text}`);
  assert.equal(shown.status, 200);
  assert.equal((await post(`/admin/inbox/${ok.text}/reject`)).status, 200);
  await drain();
});

test("kb_propose caps pending proposals per token and in total, counted under the lock", async () => {
  const { createToken } = await import("./auth/tokens");
  const mk = (n: string) => createToken(n, [{ space: "sp", project: "pj", section: "*", permission: "propose" }]).token;
  process.env.INBOX_MAX_PER_TOKEN = "2";
  try {
    const tq = mk("tok-quota");
    assert.equal((await propose(tq, { note: "q1" })).isError, false);
    assert.equal((await propose(tq, { note: "q2" })).isError, false);
    const third = await propose(tq, { note: "q3" });
    assert.equal(third.isError, true);
    assert.match(third.text, /^Too many pending proposals\. Ask the user to review the inbox\.$/);
    assert.equal(lastAudit(db, "action = 'kb_propose'").result, "error");
    assert.equal((await propose(mk("tok-quota-b"), { note: "q4" })).isError, false, "other tokens keep their own share");
    await drain();

    process.env.INBOX_MAX_PER_TOKEN = "3";
    const tc = mk("tok-quota-c");
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => propose(tc, { note: `c${i}` })));
    assert.equal(rs.filter((r) => !r.isError).length, 3);
    await drain();

    process.env.INBOX_MAX_TOTAL = String(ids().length);
    const full = await propose(mk("tok-quota-d"), { note: "q5" });
    assert.equal(full.isError, true);
    assert.match(full.text, /Too many pending proposals/);
  } finally {
    delete process.env.INBOX_MAX_PER_TOKEN;
    delete process.env.INBOX_MAX_TOTAL;
  }
});

test("accept validates and commits what is on disk inside the lock, not a stale read", async () => {
  const { syncInboxResolve } = await import("./vault/git");
  const id = (await propose(tW, { note: "stale", content: "old\n" })).text;
  const holdId = (await propose(tW, { note: "stale-hold" })).text;
  await drain();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inLock = new Promise<void>((r) => (entered = r));
  const holder = syncInboxResolve(vault, inboxPath(vault, holdId), async () => {
    entered();
    await gate;
    return { message: "hold" };
  });
  await inLock;
  const accepting = post(`/admin/inbox/${id}/accept`);
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(
    inboxPath(vault, id),
    serializeProposal({ target: "sp/pj/notes/stale", proposedBy: "tok-w", reason: "r", created: "2020-01-01T00:00:00.000Z", content: "new\n" }),
  );
  release();
  await holder;
  assert.equal((await accepting).status, 200);
  await drain();
  assert.equal(stripFm(readFileSync(join(vault, "sp/pj/notes/stale.md"), "utf8")), "new\n");
});

test("accept applies kb_write content rules (size cap, archive, entry-note cap, bad target)", async () => {
  manual(mid(1), "sp/pj/notes/big", "a".repeat(600_000));
  manual(mid(2), "sp/pj/archive/x", "c\n");
  manual(mid(3), "sp/pj/overview/index", "x".repeat(5000));
  manual(mid(4), "_inbox/pj/notes/x", "c\n");
  manual(mid(5), "sp/pj/notes", "c\n");
  const expect = [/too large/, /archive/, /too large|index/i, /invalid target/, /invalid target/];
  for (let i = 1; i <= 5; i++) {
    const r = await post(`/admin/inbox/${mid(i)}/accept`);
    assert.equal(r.status, 422, `${mid(i)} ${await r.clone().text()}`);
    assert.match(((await r.json()) as { error: string }).error, expect[i - 1]);
    assert.equal((await post(`/admin/inbox/${mid(i)}/reject`)).status, 200);
  }
  assert.equal(existsSync(join(vault, "sp/pj/notes/big.md")), false);
  assert.equal(existsSync(join(vault, "sp/pj/archive/x.md")), false);
  await drain();
});

test("commit reporting: untracked reject and identical overwrite report null, no failure", async () => {
  const h0 = head();
  manual(mid(10), "sp/pj/notes/untracked", "x\n");
  const rj = await post(`/admin/inbox/${mid(10)}/reject`);
  assert.equal(rj.status, 200);
  assert.equal(((await rj.json()) as { commit: unknown }).commit, null);
  assert.equal(head(), h0);

  await callTool(baseUrl, tW, "kb_write", { space: "sp", project: "pj", section: "notes", note: "same", content: "same\n" });
  await drain();
  const h1 = head();
  manual(mid(11), "sp/pj/notes/same", "same\n");
  assert.equal((await post(`/admin/inbox/${mid(11)}/accept`)).status, 409);
  const ac = await post(`/admin/inbox/${mid(11)}/accept`, { overwrite: true });
  assert.equal(ac.status, 200);
  assert.equal(((await ac.json()) as { commit: unknown }).commit, null);
  assert.equal(head(), h1);
  assert.equal(existsSync(join(vault, "_inbox", `${mid(11)}.md`)), false);

  // Tracked proposal with identical target content: still one commit (the inbox removal).
  const id = (await propose(tW, { note: "same", content: "same\n" })).text;
  await drain();
  const ac2 = await post(`/admin/inbox/${id}/accept`, { overwrite: true });
  assert.equal(ac2.status, 200);
  assert.match(((await ac2.json()) as { commit: string }).commit, /^[0-9a-f]{40}$/);
  await drain();
  assert.equal(git(["status", "--porcelain"], vault).trim(), "");
});

test("admin requests are tracked by the lifecycle and refused during shutdown", async () => {
  const { createAdminApp, listenAdmin } = await import("./admin");
  const { Lifecycle } = await import("./server");
  const http = await import("node:http");
  const l2 = new Lifecycle();
  const srv = await listenAdmin(createAdminApp(vault, l2), 0);
  const port = (srv.address() as AddressInfo).port;
  try {
    // Headers sent, body never finished: the request stays in flight.
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/admin/inbox/${mid(99)}/reject`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
    });
    req.on("error", () => undefined);
    req.write("{");
    const until = async (n: number) => {
      for (let i = 0; i < 100 && l2.inFlight !== n; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(l2.inFlight, n);
    };
    await until(1);
    req.destroy();
    await until(0);
    l2.shuttingDown = true;
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/inbox`)).status, 503);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test("a symlinked _inbox dir is refused for list/show/accept/propose", async () => {
  const id = (await propose(tW, { note: "symlinked" })).text;
  await drain();
  const real = join(vault, "_inbox-real");
  renameSync(join(vault, "_inbox"), real);
  symlinkSync(real, join(vault, "_inbox"));
  try {
    assert.equal((await fetch(`${adminUrl}/admin/inbox`)).status, 403);
    assert.equal((await fetch(`${adminUrl}/admin/inbox/${id}`)).status, 403);
    assert.equal((await post(`/admin/inbox/${id}/accept`)).status, 403);
    assert.equal((await post(`/admin/inbox/${id}/reject`)).status, 403);
    const p = await propose(tW, { note: "via-symlink" });
    assert.equal(p.isError, true);
  } finally {
    unlinkSync(join(vault, "_inbox"));
    renameSync(real, join(vault, "_inbox"));
  }
  assert.equal((await fetch(`${adminUrl}/admin/inbox/${id}`)).status, 200);
  await drain();
});

test("list reads only a bounded head, handles oversized files, and caps the listing", async () => {
  manual(mid(20), "sp/pj/notes/huge", "h".repeat(1_200_000));
  const list = (await (await fetch(`${adminUrl}/admin/inbox`)).json()) as { proposals: Array<Record<string, unknown>>; truncated: boolean };
  const huge = list.proposals.find((p) => p.id === mid(20))!;
  assert.equal(huge.target, "sp/pj/notes/huge");
  assert.ok((huge.size as number) > 1_200_000);
  assert.equal((await fetch(`${adminUrl}/admin/inbox/${mid(20)}`)).status, 413);
  assert.equal((await post(`/admin/inbox/${mid(20)}/reject`)).status, 200);

  for (let i = 0; i < 505; i++) manual(mid(1000 + i), "sp/pj/notes/many", "m\n");
  try {
    const l = (await (await fetch(`${adminUrl}/admin/inbox`)).json()) as { proposals: unknown[]; truncated: boolean };
    assert.equal(l.proposals.length, 500);
    assert.equal(l.truncated, true);
  } finally {
    for (let i = 0; i < 505; i++) unlinkSync(join(vault, "_inbox", `${mid(1000 + i)}.md`));
  }
  const after = (await (await fetch(`${adminUrl}/admin/inbox`)).json()) as { truncated: boolean };
  assert.equal(after.truncated, false);
  await drain();
});

test("kb_propose emits one inbox event on success, none on quota error, and a failing listener does not break it", async () => {
  const { onInboxEvent } = await import("./inbox");
  const { createToken } = await import("./auth/tokens");
  const seen: Array<{ id: string; target: string; proposedBy: string; reason: string; created: string }> = [];
  const off = onInboxEvent((e) => void seen.push(e.proposal));
  const offBad = onInboxEvent(() => {
    throw new Error("listener boom");
  });
  process.env.INBOX_MAX_PER_TOKEN = "1";
  try {
    const t = createToken("tok-evt", [{ space: "sp", project: "pj", section: "*", permission: "propose" }]).token;
    const ok = await propose(t, { note: "evt1" });
    assert.equal(ok.isError, false, ok.text);
    assert.deepEqual(seen, [{ id: ok.text, target: "sp/pj/notes/evt1", proposedBy: "tok-evt", reason: "worth keeping", created: seen[0]?.created }]);
    assert.equal((await propose(t, { note: "evt2" })).isError, true);
    assert.equal(seen.length, 1);
    await drain();
  } finally {
    delete process.env.INBOX_MAX_PER_TOKEN;
    off();
    offBad();
  }
});
