// Shared helpers for server*.test.ts. Importing this file sets DB_PATH to a
// throwaway DB (db.ts reads it at import time), so import it BEFORE anything
// that loads db.ts. (Named *.test.ts so tsc excludes it from the build.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const dirs: string[] = [];
const dbDir = mkdtempSync(join(tmpdir(), "sb-server-db-"));
dirs.push(dbDir);
process.env.DB_PATH = join(dbDir, "test.db");

export function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `sb-server-${prefix}-`));
  dirs.push(d);
  return d;
}

export function cleanupDirs(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function configure(dir: string): void {
  git(["config", "user.name", "Test User"], dir);
  git(["config", "user.email", "test@example.com"], dir);
}

export function newRepo(): string {
  const dir = tmp("vault");
  git(["init", "-b", "main"], dir);
  configure(dir);
  return dir;
}

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

export function lastAudit(
  db: import("better-sqlite3").Database,
  where = "1=1",
): { action: string; result: string; detail: string | null; client_ip: string | null; token_name: string | null } {
  return db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 1`).get() as never;
}
