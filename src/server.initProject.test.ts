import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, cloneRepo, git, makeBareRemote, makeTempDb } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const remote = makeBareRemote();
const vault = cloneRepo(remote, "vault");
writeFileSync(join(vault, "seed.md"), "seed\n");
git(["add", "."], vault);
git(["commit", "-m", "seed"], vault);
git(["push", "-u", "origin", "main"], vault);
process.env.VAULT_PATH = vault;

let close: () => Promise<void>;
let baseUrl: string;
let token: string;
let drain: () => Promise<void>;

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  token = createToken("tok-init", [{ space: "sp", project: "*", section: "*", permission: "write" }]).token;
  ({ baseUrl, close } = await listen(createApp({ vaultRoot: vault })));
});

after(async () => {
  await close();
  cleanup();
});

test("concurrent kb_init_project: exactly one succeeds", async () => {
  const args = { space: "sp", project: "conc", summary: "s" };
  const rs = await Promise.all([1, 2, 3, 4].map(() => callTool(baseUrl, token, "kb_init_project", args)));
  assert.equal(rs.filter((r) => !r.isError).length, 1);
  for (const r of rs.filter((r) => r.isError)) assert.match(r.text, /already exists.*kb_write/);
  assert.match(readFileSync(join(vault, "sp/conc/overview/index.md"), "utf8"), /^# conc/);
  await drain();
});

test("kb_init_project refuses a note that exists only on the remote", async () => {
  const other = cloneRepo(remote, "other");
  mkdirSync(join(other, "sp/remoteonly/overview"), { recursive: true });
  writeFileSync(join(other, "sp/remoteonly/overview/index.md"), "# hand written\n");
  git(["add", "."], other);
  git(["commit", "-m", "remote note"], other);
  git(["push"], other);

  const r = await callTool(baseUrl, token, "kb_init_project", { space: "sp", project: "remoteonly", summary: "s" });
  assert.equal(r.isError, true);
  assert.match(r.text, /already exists.*kb_write/);
  assert.equal(readFileSync(join(vault, "sp/remoteonly/overview/index.md"), "utf8"), "# hand written\n");
  await drain();
});
