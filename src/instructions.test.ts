// The instructions budget: core + User context never exceed it, notes are never cut, and the rules
// that left the instructions live in the tool descriptions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { connectClient, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

const META = [{ space: "meta", project: "*", section: "*", permission: "read" as const }];
let mod: typeof import("./userContext");
let ins: typeof import("./instructions");
let conv: typeof import("./tools/conventions");

function putNote(project: string, content: string): void {
  mkdirSync(join(vault, "meta", project, "overview"), { recursive: true });
  writeFileSync(join(vault, "meta", project, "overview", "index.md"), content);
}
function clearMeta(): void {
  rmSync(join(vault, "meta"), { recursive: true, force: true });
}
const total = async (scopes = META, budget?: number) => {
  const uc = await mod.buildUserContext(vault, scopes, budget ?? ins.userContextBudget(conv.SERVER_INSTRUCTIONS));
  return { uc, full: ins.composeInstructions(conv.SERVER_INSTRUCTIONS, uc.text) };
};

before(async () => {
  mod = await import("./userContext");
  ins = await import("./instructions");
  conv = await import("./tools/conventions");
});
after(cleanup);

test("core instructions are compact", () => {
  assert.ok(conv.SERVER_INSTRUCTIONS.length <= 1000, String(conv.SERVER_INSTRUCTIONS.length));
  assert.match(conv.SERVER_INSTRUCTIONS, /tail/);
  assert.match(conv.SERVER_INSTRUCTIONS, /User context/);
  assert.match(conv.SERVER_INSTRUCTIONS, /No access for this session/);
});

test("no meta: core only, within budget", async () => {
  clearMeta();
  const { uc, full } = await total();
  assert.deepEqual(uc, { text: "", notes: [] });
  assert.equal(full, conv.SERVER_INSTRUCTIONS);
});

test("the realistic five notes all fit", async () => {
  clearMeta();
  const sizes = [367, 420, 480, 560, 640]; // ~2.5 KB of bodies: everything fits
  ["perso-profil", "preferences", "conventions-git", "workflow-ia", "environnement"].forEach((name, i) => putNote(name, "a".repeat(sizes[i])));
  const { uc, full } = await total();
  assert.equal(uc.notes.length, 5, `total ${full.length}`);
  assert.ok(full.length <= ins.INSTRUCTIONS_MAX_CHARS, String(full.length));
  assert.doesNotMatch(full, /Not included/);
});

test("the real meta (5 indexes, 2.9 KB): all included, within budget", async () => {
  clearMeta();
  const real: Record<string, number> = { "code-conventions": 367, gotchas: 614, profile: 419, "stack-standards": 701, workflow: 837 };
  for (const [name, n] of Object.entries(real)) putNote(name, "a".repeat(n));
  const { uc, full } = await total();
  console.log(`real meta composed length: ${full.length}`);
  assert.equal(uc.notes.length, 5, `total ${full.length}`);
  assert.ok(full.length <= ins.INSTRUCTIONS_MAX_CHARS, String(full.length));
  assert.doesNotMatch(full, /Not included/);
});

test("many huge notes: some skipped and listed, whole notes only, total within budget", async () => {
  clearMeta();
  for (let i = 0; i < 12; i++) putNote(`n${String(i).padStart(2, "0")}`, `# n${i}\n` + `L${i} `.repeat(600));
  const { uc, full } = await total();
  assert.ok(full.length <= ins.INSTRUCTIONS_MAX_CHARS, String(full.length));
  assert.ok(uc.notes.length >= 1 && uc.notes.length < 12);
  assert.match(full, /Not included|more meta notes/);
  const bodies = (full.match(/^\[note /gm) ?? []).length;
  assert.equal(bodies, uc.notes.length);
  assert.equal((full.match(/^\[end /gm) ?? []).length, bodies);
  for (const p of uc.notes) {
    const i = Number(/meta\/n(\d\d)\//.exec(p)![1]);
    assert.ok(full.includes(`# n${i}\n` + `L${i} `.repeat(599) + `L${i}\n[end `), "note body complete");
  }
});

test("greedy skip: a big early note is skipped, smaller later ones are included", async () => {
  clearMeta();
  putNote("a-big", "B".repeat(3500));
  putNote("b-small", "small one");
  putNote("c-small", "small two");
  const { uc, full } = await total();
  assert.deepEqual(uc.notes, ["meta/b-small/overview/index", "meta/c-small/overview/index"]);
  assert.match(full, /Not included \(size\), kb_read overview\/index of: meta\/a-big/);
  assert.ok(full.length <= ins.INSTRUCTIONS_MAX_CHARS);
});

test("nothing fits: only the pointer line; tiny budget: nothing", async () => {
  clearMeta();
  putNote("big", "B".repeat(3000));
  const uc = await mod.buildUserContext(vault, META, 400);
  assert.equal(uc.notes.length, 0);
  assert.equal(uc.text, "Not included (size), kb_read overview/index of: meta/big");
  assert.equal((await mod.buildUserContext(vault, META, 10)).text, "");
});

test("a long skipped list degrades to a count", async () => {
  clearMeta();
  for (let i = 0; i < 20; i++) putNote(`project-with-long-name-${String(i).padStart(2, "0")}`, "B".repeat(3000));
  const uc = await mod.buildUserContext(vault, META, 3000);
  assert.equal(uc.text, "20 more meta notes: kb_list meta");
});

test("MCP_INSTRUCTIONS_MAX_CHARS is respected; invalid values fall back to the default", async () => {
  assert.equal(ins.getInstructionsMaxChars({}), 4090);
  assert.equal(ins.getInstructionsMaxChars({ MCP_INSTRUCTIONS_MAX_CHARS: "2500" }), 2500);
  assert.equal(ins.getInstructionsMaxChars({ MCP_INSTRUCTIONS_MAX_CHARS: "999" }), 4090);
  assert.equal(ins.getInstructionsMaxChars({ MCP_INSTRUCTIONS_MAX_CHARS: "abc" }), 4090);
  clearMeta();
  for (let i = 0; i < 5; i++) putNote(`p${i}`, "c".repeat(700));
  const env = { MCP_INSTRUCTIONS_MAX_CHARS: "1800" };
  const uc = await mod.buildUserContext(vault, META, ins.userContextBudget(conv.SERVER_INSTRUCTIONS, env));
  assert.ok(ins.composeInstructions(conv.SERVER_INSTRUCTIONS, uc.text, env).length <= 1800);
  assert.ok(uc.notes.length < 5);
});

test("rules moved out of the instructions sit in the right tool description", async () => {
  const { createApp } = await import("./server");
  const { createToken } = await import("./auth/tokens");
  const tok = createToken("t", [{ space: "sp", project: "pj", section: "*", permission: "read" }]).token;
  const app = await listen(createApp({ vaultRoot: vault }));
  const { client, transport } = await connectClient(app.baseUrl, tok);
  try {
    const d = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));
    const has = (tool: string, ...re: RegExp[]) => {
      for (const r of re) assert.match(d[tool], r, `${tool}: ${r}`);
      assert.ok(d[tool].length < 2048, `${tool} description too long: ${d[tool].length}`);
    };
    has("kb_write", /Docs map/, /sources/, /re-read/, /one topic per note/, /Reserved sections/, /3072 bytes/, /handover/, /auto-archive/, /kb_propose or kb_write/, /direct git commits/);
    has("kb_init_project", /Docs map/, /Reserved sections/, /3 KB/, /handover/, /auto-archive/);
    has("kb_append", /timestamped/);
    has("kb_archive", /instead of deleting/, /write \(which includes read\)/);
    has("kb_history", /who changed what/);
    has("kb_search", /`type`/, /kb_list/);
    has("kb_propose", /kb_append/, /not sure/);
    has("kb_request_access", /kb_access_status/, /Do NOT request up front/, /No access for this session/, /meta space/, /denial changes nothing/, /Only the user grants/);
    has("kb_access_status", /denial changes nothing/);
  } finally {
    await transport.close();
    await app.close();
  }
});

test("the User context preamble says these are index notes and to kb_read the referenced ones", async () => {
  clearMeta();
  putNote("prefs", "hello");
  const { uc } = await total();
  assert.match(uc.text, /index notes/);
  assert.match(uc.text, /kb_read the notes they reference/);
});
