// Covers the per-request transport/server cleanup fix in server.ts: the
// res.on("close", ...) listener must be registered before any await (so a
// client disconnect while the request is still in flight isn't missed), and
// cleanup must also run if server.connect()/transport setup throws.
//
// We can't easily force a true "client disconnects mid handleRequest" via a
// real end-to-end MCP round trip (it completes too fast to hit reliably), so
// instead we deterministically stall the handler mid-flight by patching
// McpServer.prototype.connect to hang on a gate we control, then abort the
// client while it's stuck there — this exercises exactly the window the fix
// targets, without relying on timing luck.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeTempDb, makeTempVault } from "./test-support/fixtures";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

makeTempDb();
const { vault: vaultRoot } = makeTempVault();
process.env.VAULT_PATH = vaultRoot;

let createToken: typeof import("./auth/tokens").createToken;
let createApp: typeof import("./server").createApp;

let server: Server;
let port: number;
let token: string;

before(async () => {
  ({ createToken } = await import("./auth/tokens"));
  ({ createApp } = await import("./server"));

  token = createToken("cleanup-test", [{ space: "sp", project: "proj", section: "sect", permission: "write" }])
    .token;

  await new Promise<void>((resolve) => {
    server = createApp({ vaultRoot }).listen(0, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  cleanup();
});

// Swaps a method on a prototype, returns a restore function. Used to spy on
// (or stall) instances server.ts creates internally without changing its
// structure just for testability.
function patch<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K]): () => void {
  const original = obj[key];
  obj[key] = impl;
  return () => {
    obj[key] = original;
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Polls until cond() holds, with a generous timeout instead of a fixed delay.
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function postMcp(): http.ClientRequest {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cleanup-test", version: "0.1.0" },
      },
    }),
  );
  const req = http.request({
    hostname: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": payload.length,
    },
  });
  req.on("error", () => {
    /* expected once we destroy() it below */
  });
  req.end(payload);
  return req;
}

test("client disconnect while the handler is still mid-flight still closes transport/server", async () => {
  let transportCloseCalls = 0;
  let serverCloseCalls = 0;
  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let connectEntered!: () => void;
  const enteredConnect = new Promise<void>((resolve) => {
    connectEntered = resolve;
  });
  let connectReturned!: () => void;
  const returnedFromConnect = new Promise<void>((resolve) => {
    connectReturned = resolve;
  });

  const restoreConnect = patch(McpServer.prototype, "connect", async function (
    this: McpServer,
  ) {
    connectEntered();
    await connectGate; // simulate the handler being stuck mid-await, like a real in-flight request
    connectReturned();
  } as McpServer["connect"]);
  const restoreTransportClose = patch(
    StreamableHTTPServerTransport.prototype,
    "close",
    async function (this: StreamableHTTPServerTransport) {
      transportCloseCalls++;
    } as StreamableHTTPServerTransport["close"],
  );
  const restoreServerClose = patch(McpServer.prototype, "close", async function (
    this: McpServer,
  ) {
    serverCloseCalls++;
  } as McpServer["close"]);

  try {
    const req = postMcp();

    // Let the request reach the handler and get stuck on the patched connect().
    await enteredConnect;
    assert.equal(transportCloseCalls, 0, "sanity: handler should still be mid-flight, not closed yet");

    // Client disconnects while still mid-flight — this is the race the fix closes.
    req.destroy();
    await waitFor(() => transportCloseCalls > 0 && serverCloseCalls > 0, "cleanup after client disconnect");
    await tick(); // give any (incorrect) duplicate close a chance to show up

    assert.equal(transportCloseCalls, 1, "transport.close() should run exactly once");
    assert.equal(serverCloseCalls, 1, "server.close() should run exactly once");
  } finally {
    releaseConnect();
    // Let the now-unstuck handler finish unwinding before restoring/next test.
    // Bounded, since connect() may never have been entered if the test failed early.
    await Promise.race([returnedFromConnect, new Promise((r) => setTimeout(r, 1000))]);
    await tick();
    restoreConnect();
    restoreTransportClose();
    restoreServerClose();
  }
});

test("server.connect() throwing still closes the transport (no leak on setup failure)", async () => {
  let transportCloseCalls = 0;
  const restoreConnect = patch(McpServer.prototype, "connect", async function (
    this: McpServer,
  ) {
    throw new Error("simulated connect failure");
  } as McpServer["connect"]);
  const restoreTransportClose = patch(
    StreamableHTTPServerTransport.prototype,
    "close",
    async function (this: StreamableHTTPServerTransport) {
      transportCloseCalls++;
    } as StreamableHTTPServerTransport["close"],
  );

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = postMcp();
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
    });

    assert.equal(status, 500);
    assert.equal(transportCloseCalls, 1, "transport.close() should still run when connect() throws");
  } finally {
    restoreConnect();
    restoreTransportClose();
  }
});
