#!/usr/bin/env node
import { createToken, listTokens, revokeToken, Scope } from "../auth/tokens";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  return args;
}

function parseScopes(raw: string): Scope[] {
  return raw.split(",").map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 3) {
      throw new Error(`invalid scope "${entry}", expected project:section:permission`);
    }
    const [project, section, permission] = parts;
    if (permission !== "read" && permission !== "write") {
      throw new Error(`invalid permission "${permission}" in scope "${entry}", must be read or write`);
    }
    return { project, section, permission };
  });
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function cmdCreate(args: Record<string, string>): void {
  const { name, scope } = args;
  if (!name) fail("--name is required");
  if (!scope) fail("--scope is required");

  let scopes: Scope[];
  try {
    scopes = parseScopes(scope);
  } catch (err) {
    fail((err as Error).message);
  }

  const created = createToken(name, scopes);
  console.log("Token created. The plaintext token is shown ONLY ONCE below — store it now:");
  console.log("");
  console.log(`  id:    ${created.id}`);
  console.log(`  token: ${created.token}`);
  console.log("");
}

function cmdList(): void {
  const tokens = listTokens();
  if (tokens.length === 0) {
    console.log("No tokens.");
    return;
  }
  for (const t of tokens) {
    const scopesStr = t.scopes
      .map((s) => `${s.project}:${s.section}:${s.permission}`)
      .join(", ");
    console.log(
      [
        `id=${t.id}`,
        `name=${t.name}`,
        `created_at=${t.created_at}`,
        `revoked_at=${t.revoked_at ?? "-"}`,
        `last_used_at=${t.last_used_at ?? "never"}`,
        `scopes=[${scopesStr}]`,
      ].join("  "),
    );
  }
}

function cmdRevoke(args: Record<string, string>): void {
  const { id } = args;
  if (!id) fail("--id is required");

  const revoked = revokeToken(id);
  if (revoked) {
    console.log(`Token ${id} revoked.`);
  } else {
    console.log(`Token ${id} not found (or already revoked).`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    switch (command) {
      case "create":
        cmdCreate(args);
        break;
      case "list":
        cmdList();
        break;
      case "revoke":
        cmdRevoke(args);
        break;
      default:
        fail(`unknown command "${command}". Usage: token.js <create|list|revoke> [options]`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

main();
