import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let baseUrl: string;
let close: () => Promise<void>;
let tok: string;
let drain: () => Promise<void>;

const SECRET = "ghp_" + "a".repeat(36);
const MESSAGE =
  "Refused: the content looks like it contains a secret (GitHub token, line 2). Remove it: the vault is a git repository pushed to a remote, secrets would stay in its history.";
const commits = (): number => Number(git(["rev-list", "--count", "HEAD"], vault).trim());
const call = (name: string, args: Record<string, unknown>) => callTool(baseUrl, tok, name, args);
const at = (note: string, section = "notes") => ({ space: "sp", project: "pj", section, note });

before(async () => {
  writeFileSync(join(vault, "seed.md"), "seed\n");
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);
  const { createToken } = await import("./auth/tokens");
  ({ db } = await import("./db"));
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  tok = createToken("tok-sg", [
    { space: "sp", project: "pj", section: "*", permission: "read" },
    { space: "sp", project: "pj", section: "*", permission: "write" },
    { space: "sp", project: "*", section: "*", permission: "write" },
  ]).token;
  ({ baseUrl, close } = await listen(createApp({ vaultRoot: vault })));
});

after(async () => {
  await close();
  cleanup();
});

// The call is refused with the generic message, nothing is committed, the audit names kind and line only.
async function assertRefused(action: string, r: { isError: boolean; text: string }, n: number, line = 2): Promise<void> {
  await drain();
  assert.equal(r.isError, true, r.text);
  assert.equal(r.text, MESSAGE.replace("line 2", `line ${line}`));
  assert.equal(commits(), n);
  const a = lastAudit(db, `action = '${action}'`);
  assert.equal(a.result, "error");
  assert.equal(a.detail, `secret detected: GitHub token line ${line}`);
  assert.ok(!JSON.stringify(a).includes(SECRET));
}

test("kb_write refuses a secret", async () => {
  const n = commits();
  const r = await call("kb_write", { ...at("w"), content: `# W\nkey ${SECRET}\n` });
  await assertRefused("kb_write", r, n);
  assert.equal(existsSync(join(vault, "sp/pj/notes/w.md")), false);
});

test("kb_edit refuses a final content with a secret", async () => {
  assert.equal((await call("kb_write", { ...at("e"), content: "# E\nhello\n" })).isError, false);
  await drain();
  const n = commits();
  const line = readFileSync(join(vault, "sp/pj/notes/e.md"), "utf8").split("\n").indexOf("hello") + 1;
  const r = await call("kb_edit", { ...at("e"), edits: [{ old_str: "hello", new_str: `key ${SECRET}` }] });
  await assertRefused("kb_edit", r, n, line);
  assert.doesNotMatch(readFileSync(join(vault, "sp/pj/notes/e.md"), "utf8"), /ghp_/);
});

test("kb_append refuses a secret in the entry", async () => {
  const n = commits();
  const r = await call("kb_append", { ...at("2026-11", "journal"), entry: `used ${SECRET}` });
  await assertRefused("kb_append", r, n, 1);
});

test("kb_propose refuses a secret in the content and in the reason", async () => {
  const n = commits();
  const r = await call("kb_propose", { ...at("p"), content: `# P\nkey ${SECRET}\n`, reason: "why" });
  await assertRefused("kb_propose", r, n);
  const r2 = await call("kb_propose", { ...at("p"), content: "# P\n", reason: `see ${SECRET}` });
  await assertRefused("kb_propose", r2, n, 1);
  assert.equal(existsSync(join(vault, "_inbox")) ? readdirSync(join(vault, "_inbox")).length : 0, 0);
});

test("kb_init_project refuses a secret in the summary", async () => {
  const n = commits();
  const r = await call("kb_init_project", { space: "sp", project: "newp", summary: `token ${SECRET}` });
  await assertRefused("kb_init_project", r, n, 3);
  assert.equal(existsSync(join(vault, "sp/newp")), false);
});

test("inbox accept re-checks a proposal written by hand", async () => {
  const { inboxPath, serializeProposal } = await import("./inbox");
  const { createAdminApp, listenAdmin } = await import("./admin");
  const { Lifecycle } = await import("./server");
  const admin = await listenAdmin(createAdminApp(vault, new Lifecycle()), 0);
  try {
    const id = "20200101T000000Z-abcdef";
    const created = "2020-01-01T00:00:00.000Z";
    const target = "sp/pj/notes/acc";
    mkdirSync(join(vault, "_inbox"), { recursive: true });
    writeFileSync(inboxPath(vault, id), serializeProposal({ target, proposedBy: "hand", reason: "r", created, content: `# A\nkey ${SECRET}\n` }));
    git(["add", "."], vault);
    git(["commit", "-m", "hand proposal"], vault);
    const n = commits();
    const port = (admin.address() as import("node:net").AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/admin/inbox/${id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 422);
    assert.equal(commits(), n);
    assert.equal(existsSync(join(vault, "sp/pj/notes/acc.md")), false);
    const a = lastAudit(db, "action = 'inbox_accept'");
    assert.equal(a.result, "error");
    assert.match(a.detail ?? "", /secret detected: GitHub token line 2$/);
    assert.ok(!JSON.stringify(a).includes(SECRET));
  } finally {
    await new Promise((res) => admin.close(res));
  }
});
