import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import { callTool, listen } from "./test-support/server";

makeTempDb();
const { vault } = makeTempVault();
process.env.VAULT_PATH = vault;

let db: typeof import("./db").db;
let app: Awaited<ReturnType<typeof listen>>;

before(async () => {
  ({ db } = await import("./db"));
  const { createApp } = await import("./server");
  app = await listen(createApp({ vaultRoot: vault }));
});

after(async () => {
  await app.close();
  cleanup();
});

const scopes = [{ space: "pro", project: "*", section: "*", permission: "read" as const }];
const post = (token: string) =>
  fetch(`${app.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });

test("expired token gets 401, not-yet-expired token works", async () => {
  const { createToken } = await import("./auth/tokens");
  const ok = createToken("fresh", scopes, { expiresInDays: 1 });
  const old = createToken("old", scopes, { expiresInDays: 1 });
  assert.equal((await post(ok.token)).status, 200);
  assert.equal((await post(old.token)).status, 200);

  db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), old.id);
  assert.equal((await post(old.token)).status, 401);
  assert.equal((await post(ok.token)).status, 200);
  const r = await callTool(app.baseUrl, ok.token, "kb_read", { space: "pro", project: "p", section: "s", note: "n" });
  assert.equal(r.isError, true);
});

test("expired token: 401 'token expired', audited, not counted by the auth limiter; unknown tokens are", async () => {
  const { createToken } = await import("./auth/tokens");
  const { createApp, AuthFailureLimiter } = await import("./server");
  const lim = await listen(createApp({ vaultRoot: vault, authLimiter: new AuthFailureLimiter(3, 60_000) }));
  try {
    const old = createToken("old2", scopes, { expiresInDays: 1 });
    db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), old.id);
    const hit = (tok: string) =>
      fetch(`${lim.baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
    const audited = () => db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth' AND detail LIKE 'token expired%'").get() as { n: number };
    const was = audited().n;
    for (let i = 0; i < 6; i++) {
      const r = await hit(old.token);
      assert.equal(r.status, 401, "never 429 for expired");
      assert.deepEqual(await r.json(), { error: "token expired" });
    }
    const rows = { length: audited().n - was };
    assert.equal(rows.length, 1, "expired attempts are audit-coalesced per IP/minute");
    // Unknown tokens still feed the limiter.
    for (let i = 0; i < 3; i++) assert.equal((await hit("sb_nope")).status, 401);
    assert.equal((await hit("sb_nope")).status, 429);
  } finally {
    await lim.close();
  }
});
