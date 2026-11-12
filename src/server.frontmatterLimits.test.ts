// Space limits must measure the final bytes, frontmatter included.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

process.env.SPACE_LIMITS = "lim:maxNoteBytes=120,maxProjectBytes=400";
makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let baseUrl: string;
let closeMain: () => Promise<void>;
let admin: import("node:http").Server;
let adminUrl: string;
let tok: string;
let drain: () => Promise<void>;

const body60 = `${"x".repeat(59)}\n`; // alone it fits 120 bytes, with the frontmatter it does not
const write = (project: string, note: string, content: string) =>
  callTool(baseUrl, tok, "kb_write", { space: "lim", project, section: "notes", note, content });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  const { createAdminApp, listenAdmin } = await import("./admin");
  tok = createToken("tok-l", [
    { space: "lim", project: "*", section: "*", permission: "read" },
    { space: "lim", project: "*", section: "*", permission: "write" },
    { space: "lim", project: "*", section: "*", permission: "propose" },
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

test("kb_write: the per-note limit counts the frontmatter", async () => {
  const big = await write("w", "big", body60);
  assert.equal(big.isError, true);
  assert.match(big.text, /Note too large for lim/);
  assert.equal((await write("w", "small", "tiny\n")).isError, false);
});

test("web create/edit: the limit counts the frontmatter", async () => {
  const { createNote, editNote, sha256Hex } = await import("./admin/vault");
  const t = { space: "lim", project: "web", section: "notes", note: "n" };
  await assert.rejects(createNote(vault, t, body60, "u"), /Note too large for lim/);
  await createNote(vault, t, "tiny\n", "u");
  const cur = readFileSync(join(vault, "lim/web/notes/n.md"), "utf8");
  await assert.rejects(editNote(vault, t, cur.replace("tiny", "x".repeat(59)), sha256Hex(cur), "u"), /Note too large for lim/);
});

test("inbox accept: the limit counts the frontmatter added on accept", async () => {
  const p = await callTool(baseUrl, tok, "kb_propose", { space: "lim", project: "ib", section: "notes", note: "n", content: body60, reason: "r" });
  const r = await fetch(`${adminUrl}/admin/inbox/${p.text}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /Note too large for lim/);
});

test("migration: notes that would break the project limit are skipped and reported", async () => {
  mkdirSync(join(vault, "lim/mg/notes"), { recursive: true });
  for (const n of ["n1", "n2", "n3", "n4", "n5"]) writeFileSync(join(vault, `lim/mg/notes/${n}.md`), "0123456789\n");
  git(["add", "-A"], vault);
  git(["commit", "-qm", "seed"], vault);
  const out = await (await import("./cli/migrate")).run(["frontmatter"], adminUrl);
  assert.match(out, /Migrated 4 note\(s\)/);
  assert.match(out, /skipped lim\/mg\/notes\/n5: Size limit reached/);
  assert.match(readFileSync(join(vault, "lim/mg/notes/n1.md"), "utf8"), /^---\ntype: note\nauthor: migration\n/);
  assert.equal(readFileSync(join(vault, "lim/mg/notes/n5.md"), "utf8"), "0123456789\n");
});
