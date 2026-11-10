#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { createToken, listTokens, revokeToken } from "../auth/tokens";
import { Permission, Scope } from "../auth/types";

// Shape only (project:section:permission); createToken validates the values.
export function parseScopes(raw: string): Scope[] {
  return raw.split(",").map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 3) {
      throw new Error(`invalid scope "${entry}", expected project:section:permission`);
    }
    const [project, section, permission] = parts;
    return { project, section, permission: permission as Permission };
  });
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function cmdCreate(argv: string[]): void {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      scope: { type: "string" },
    },
  });
  const { name, scope } = values;
  if (!name) fail("--name is required");
  if (!scope) fail("--scope is required");

  let scopes: Scope[];
  try {
    scopes = parseScopes(scope);
  } catch (err) {
    fail((err as Error).message);
  }

  // TokenValidationError messages are printed cleanly by main()'s catch.
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

function cmdRevoke(argv: string[]): void {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      id: { type: "string" },
    },
  });
  const { id } = values;
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

  try {
    switch (command) {
      case "create":
        cmdCreate(rest);
        break;
      case "list":
        cmdList();
        break;
      case "revoke":
        cmdRevoke(rest);
        break;
      default:
        fail(`unknown command "${command}". Usage: token.js <create|list|revoke> [options]`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

// Guard so this module can be imported for testing (e.g. parseScopes)
// without running the CLI itself.
if (require.main === module) {
  main();
}
