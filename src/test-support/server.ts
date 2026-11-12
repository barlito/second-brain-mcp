// HTTP/MCP helpers for server*.test.ts. Excluded from the build via tsconfig.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export async function listen(app: Express): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.equal(first.type, "text");
  return (first as { type: "text"; text: string }).text;
}

export async function connectClient(baseUrl: string, token: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

// One call, result mapped to { isError, text }.
export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const { client, transport } = await connectClient(baseUrl, token);
  try {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: r.isError === true, text: textOf(r) };
  } finally {
    await transport.close();
  }
}

/** A row of the audit_log table. */
export interface AuditRow {
  id: number;
  ts: string;
  token_id: string | null;
  token_name: string | null;
  action: string;
  space: string | null;
  project: string | null;
  section: string | null;
  note: string | null;
  result: string;
  detail: string | null;
  git_commit: string | null;
  client_ip: string | null;
}

export function lastAudit(
  db: import("better-sqlite3").Database,
  where = "1=1",
): AuditRow {
  return db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 1`).get() as AuditRow;
}
