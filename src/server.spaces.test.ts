import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, lastAudit, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let createToken: typeof import("./auth/tokens").createToken;
let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;
const proReadName = "pro-ro";
let proRead: string;

before(async () => {
  ({ createToken } = await import("./auth/tokens"));
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");
  proRead = createToken(proReadName, [{ space: "pro", project: "*", section: "*", permission: "read" }]).token;
  for (const space of ["pro", "perso"]) {
    mkdirSync(join(vault, space, "x", "y"), { recursive: true });
    writeFileSync(join(vault, space, "x", "y", "n.md"), `${space} note\n`);
  }
  git(["add", "."], vault);
  git(["commit", "-m", "seed"], vault);
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

test("pro:*:* read token reads pro/x/y/n, is denied perso/x/y/n and any write", async () => {
  const ok = await callTool(app.baseUrl, proRead, "kb_read", { space: "pro", project: "x", section: "y", note: "n" });
  assert.deepEqual(ok, { isError: false, text: "pro note\n" });
  assert.equal(lastAudit(db, `token_name = '${proReadName}'`).result, "ok");

  const cross = await callTool(app.baseUrl, proRead, "kb_read", { space: "perso", project: "x", section: "y", note: "n" });
  assert.deepEqual(cross, { isError: true, text: "Permission denied." });
  const row = lastAudit(db, `token_name = '${proReadName}'`) as { result: string; space: string };
  assert.equal(row.result, "denied");
  assert.equal(row.space, "perso");

  for (const space of ["pro", "perso"]) {
    const w = await callTool(app.baseUrl, proRead, "kb_write", {
      space, project: "x", section: "y", note: "new", content: "nope",
    });
    assert.deepEqual(w, { isError: true, text: "Permission denied." });
  }
  assert.throws(() => git(["cat-file", "-e", "HEAD:pro/x/y/new.md"], vault));
});

test("space is required on kb_read / kb_write", async () => {
  const r = await callTool(app.baseUrl, proRead, "kb_read", { project: "x", section: "y", note: "n" }).catch(
    (e: Error) => ({ isError: true, text: e.message }),
  );
  assert.equal(r.isError, true);
});

test("a master token writes anywhere; commit message and audit row carry the space", async () => {
  const master = createToken("master-t", [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ]).token;
  const w = await callTool(app.baseUrl, master, "kb_write", {
    space: "idees", project: "p", section: "s", note: "n1", content: "hi\n",
  });
  assert.equal(w.isError, false);
  assert.match(git(["log", "-1", "--format=%s"], vault), /kb_write: idees\/p\/s\/n1 via master-t/);
  const row = lastAudit(db, "token_name = 'master-t' AND action = 'kb_write'") as { space: string; result: string };
  assert.equal(row.space, "idees");
  assert.equal(row.result, "ok");
  const r = await callTool(app.baseUrl, master, "kb_read", { space: "idees", project: "p", section: "s", note: "n1" });
  assert.equal(r.text, "hi\n");
});

test("a legacy-scoped token (post-migration) cannot access any real space", async () => {
  const t = createToken("legacy-t", [{ space: "pro", project: "x", section: "y", permission: "read" }]).token;
  db.prepare("UPDATE scopes SET space = 'legacy' WHERE token_id = (SELECT id FROM tokens WHERE name = 'legacy-t')").run();
  for (const space of ["pro", "perso", "legacy"]) {
    const r = await callTool(app.baseUrl, t, "kb_read", { space, project: "x", section: "y", note: "n" });
    // 'legacy' itself is a slug but the vault has no such directory: must not read anything.
    assert.notEqual(r.text, `${space} note\n`);
  }
  const r = await callTool(app.baseUrl, t, "kb_read", { space: "pro", project: "x", section: "y", note: "n" });
  assert.deepEqual(r, { isError: true, text: "Permission denied." });
});
