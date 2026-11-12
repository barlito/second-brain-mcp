import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { claudeAddCommand, DEFAULT_MCP_URL, dirProblem, mcpUrl, shellQuote } from "./mcpCommand";

const URL = "https://second-brain.barlito.fr/mcp";

test("claudeAddCommand: without and with a directory", () => {
  const base = `claude mcp add --scope local --transport http second-brain ${URL} --header "Authorization: Bearer sb_abc"`;
  assert.equal(claudeAddCommand({ url: URL, token: "sb_abc" }), base);
  assert.equal(claudeAddCommand({ url: URL, token: "sb_abc", dir: "  " }), base);
  assert.equal(claudeAddCommand({ url: URL, token: "sb_abc", dir: "/home/me/proj" }), `cd /home/me/proj && ${base}`);
});

test("directory quoting: spaces, quotes and shell metacharacters", () => {
  assert.equal(shellQuote("/a b"), "'/a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("$(rm -rf x);`id`"), "'$(rm -rf x);`id`'");
  const c = claudeAddCommand({ url: URL, token: "t", dir: "/tmp/a b; touch /tmp/pwned" });
  assert.match(c, /^cd '\/tmp\/a b; touch \/tmp\/pwned' && claude /);
  // ~ still expands, the rest is quoted.
  assert.match(claudeAddCommand({ url: URL, token: "t", dir: "~/My Proj" }), /^cd ~\/'My Proj' && /);
  assert.match(claudeAddCommand({ url: URL, token: "t", dir: "~" }), /^cd ~ && /);
});

test("directory quoting is real: a shell reads back exactly the directory", () => {
  for (const dir of ["/tmp/a b", "/tmp/it's", "/tmp/$HOME `x` \"q\" ; &&", "/tmp/ü é"]) {
    const out = spawnSync("sh", ["-c", `printf %s ${shellQuote(dir)}`], { encoding: "utf8" });
    assert.equal(out.stdout, dir);
  }
});

test("dirProblem rejects newlines, control characters and huge values; command refuses them", () => {
  assert.match(dirProblem("a\nb") ?? "", /control characters/);
  assert.match(dirProblem("a\0b") ?? "", /control characters/);
  assert.match(dirProblem("x".repeat(513)) ?? "", /too long/);
  assert.equal(dirProblem("/ok/dir"), undefined);
  assert.throws(() => claudeAddCommand({ url: URL, token: "t", dir: "a\nb" }), /control characters/);
});

test("mcpUrl: env value, default, and invalid values", () => {
  assert.equal(mcpUrl({}), DEFAULT_MCP_URL);
  assert.equal(mcpUrl({ PUBLIC_MCP_URL: "  " }), DEFAULT_MCP_URL);
  assert.equal(mcpUrl({ PUBLIC_MCP_URL: "https://second-brain.local.barlito.fr/mcp" }), "https://second-brain.local.barlito.fr/mcp");
  const orig = console.error;
  console.error = () => undefined;
  try {
    for (const bad of ["not a url", "ftp://x/mcp", 'https://x/mcp" ; rm -rf ~ #', "javascript:alert(1)"]) {
      assert.equal(mcpUrl({ PUBLIC_MCP_URL: bad }), DEFAULT_MCP_URL, bad);
    }
  } finally {
    console.error = orig;
  }
});
