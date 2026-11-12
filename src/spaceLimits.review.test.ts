import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

process.env.SPACE_LIMITS = "agents:maxNotes=3,maxNoteBytes=1000,archiveAfterDays=30;tiny:maxNoteBytes=100";
makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let app: Awaited<ReturnType<typeof listen>>;
let agent: string;
let drain: () => Promise<void>;
const w = (project: string, note: string, content: string) =>
  callTool(app.baseUrl, agent, "kb_write", { space: "agents", project, section: "notes", note, content });

before(async () => {
  const { createToken } = await import("./auth/tokens");
  ({ drainWrites: drain } = await import("./vault/git"));
  const { createApp } = await import("./server");
  agent = createToken("bot", [
    { space: "agents", project: "*", section: "*", permission: "write" },
    { space: "tiny", project: "*", section: "*", permission: "write" },
  ]).token;
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await drain();
  await app.close();
  cleanup();
});

test("syncWrite check hook sees the final bytes and refuses before anything is written", async () => {
  const { syncWrite } = await import("./vault/git");
  const target = join(vault, "agents/hook/notes/n.md");
  let seen = "";
  await assert.rejects(
    syncWrite(vault, target, "abc", "m", {
      check: (next) => {
        seen = next;
        throw new Error("nope");
      },
    }),
    /nope/,
  );
  assert.equal(seen, "abc");
  assert.equal(existsSync(target), false);
});

test("kb_init_project: maxNoteBytes smaller than the template blames the space config", async () => {
  const r = await callTool(app.baseUrl, agent, "kb_init_project", { space: "tiny", project: "x", summary: "s" });
  assert.equal(r.isError, true);
  assert.match(r.text, /space limit maxNoteBytes \(100\) is too small for the project template/);
  assert.doesNotMatch(r.text, /shorter/);
});

test("web edit: stale base gives 409 before the limit check (422)", async () => {
  const { createNote, editNote, sha256Hex } = await import("./admin/vault");
  const t = { space: "agents", project: "p11", section: "notes", note: "a" };
  await createNote(vault, t, "one", "u");
  await assert.rejects(editNote(vault, t, "x".repeat(1100), sha256Hex("stale"), "u"), (e: { status?: number }) => e.status === 409);
  const cur = readFileSync(join(vault, "agents/p11/notes/a.md"), "utf8"); // with its frontmatter
  await assert.rejects(editNote(vault, t, "x".repeat(1100), sha256Hex(cur), "u"), (e: { status?: number }) => e.status === 422);
});

test("usage counts only notes the tools can see (valid slugs)", async () => {
  mkdirSync(join(vault, "agents/p12/notes"), { recursive: true });
  mkdirSync(join(vault, "agents/p12/Weird"), { recursive: true });
  writeFileSync(join(vault, "agents/p12/notes/UPPER.md"), "x");
  writeFileSync(join(vault, "agents/p12/notes/has space.md"), "x");
  writeFileSync(join(vault, "agents/p12/Weird/x.md"), "x");
  for (const n of ["a", "b", "c"]) assert.equal((await w("p12", n, n)).isError, false);
});

test("AUTO_ARCHIVE_INTERVAL_MS validation", async () => {
  const { parseAutoArchiveInterval } = await import("./autoArchive");
  assert.equal(parseAutoArchiveInterval(undefined), 86_400_000);
  assert.equal(parseAutoArchiveInterval(""), 86_400_000);
  assert.equal(parseAutoArchiveInterval("0"), 0);
  assert.equal(parseAutoArchiveInterval("3600000"), 3_600_000);
  assert.equal(parseAutoArchiveInterval(String(2 ** 31 - 1)), 2 ** 31 - 1);
  for (const bad of ["abc", "-1", "1.5", String(2 ** 31), "1e3"]) {
    assert.throws(() => parseAutoArchiveInterval(bad), /AUTO_ARCHIVE_INTERVAL_MS/, bad);
  }
});

test("auto-archive is skipped when the pull before it fails", async () => {
  const { runAutoArchive } = await import("./autoArchive");
  const { vault: v2 } = makeTempVault({ remote: true });
  const old = new Date(Date.now() - 90 * 86400_000).toISOString();
  mkdirSync(join(v2, "agents/q/notes"), { recursive: true });
  writeFileSync(join(v2, "agents/q/notes/n.md"), "old\n");
  execFileSync("git", ["add", "--", "agents"], { cwd: v2 });
  execFileSync("git", ["commit", "-q", "-m", "old"], { cwd: v2, env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old } });
  git(["remote", "set-url", "origin", "/nonexistent/remote.git"], v2);
  const r = await runAutoArchive(v2);
  assert.equal(r.skipped, true);
  assert.ok(existsSync(join(v2, "agents/q/notes/n.md")));
});
