#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { createToken, listTokens, revokeToken, validateTokenInput } from "../auth/tokens";
import { Permission, Scope } from "../auth/types";

// Shape only (space:project:section:permission); createToken validates the values.
export function parseScopes(raw: string): Scope[] {
  return raw.split(",").map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 4) {
      throw new Error(`invalid scope "${entry}", expected space:project:section:permission`);
    }
    const [space, project, section, permission] = parts;
    return { space, project, section, permission: permission as Permission };
  });
}

export const PRESETS: Record<string, Scope[]> = {
  master: [
    { space: "*", project: "*", section: "*", permission: "read" },
    { space: "*", project: "*", section: "*", permission: "write" },
  ],
  "master-ro": [{ space: "*", project: "*", section: "*", permission: "read" }],
};

// Resolves --preset / --scope (exactly one) into scopes.
export function resolveScopes(preset: string | undefined, scope: string | undefined): Scope[] {
  if (preset && scope) throw new Error("use either --preset or --scope, not both");
  if (preset) {
    const p = PRESETS[preset];
    if (!p) throw new Error(`unknown preset "${preset}", expected one of: ${Object.keys(PRESETS).join(", ")}`);
    return p.map((s) => ({ ...s }));
  }
  if (!scope) throw new Error("--preset or --scope is required");
  return parseScopes(scope);
}

export function formatScope(s: Scope): string {
  return `${s.space}:${s.project}:${s.section}:${s.permission}`;
}

// One line per wildcard scope; empty when the token has none.
export function wildcardWarnings(scopes: Scope[]): string[] {
  return scopes
    .filter((s) => s.space === "*" || s.project === "*" || s.section === "*")
    .map((s) => {
      const where =
        s.space === "*"
          ? "EVERY space, project and section"
          : s.project === "*"
            ? `every project and section in space "${s.space}"`
            : `every section of ${s.space}/${s.project}`;
      return `WARNING: scope ${formatScope(s)} - this token can ${s.permission} ${where}, including ones created later.`;
    });
}

const covers = (a: string, b: string) => a === "*" || a === b;

// Drops scopes strictly narrower than another scope of the same permission
// (e.g. *:*:*:read makes pro:x:y:read redundant). Input must be de-duplicated.
export function dropRedundantScopes(scopes: Scope[]): { kept: Scope[]; dropped: Scope[] } {
  const kept: Scope[] = [];
  const dropped: Scope[] = [];
  for (const s of scopes) {
    const redundant = scopes.some(
      (o) =>
        o !== s &&
        o.permission === s.permission &&
        covers(o.space, s.space) &&
        covers(o.project, s.project) &&
        covers(o.section, s.section),
    );
    (redundant ? dropped : kept).push(s);
  }
  return { kept, dropped };
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
      preset: { type: "string" },
      "allow-wildcard": { type: "boolean" },
      "expires-in-days": { type: "string" },
    },
  });
  const { name, scope, preset } = values;
  if (!name) fail("--name is required");

  let scopes: Scope[];
  try {
    scopes = resolveScopes(preset, scope);
  } catch (err) {
    fail((err as Error).message);
  }

  // TokenValidationError messages are printed cleanly by main()'s catch.
  const validated = validateTokenInput(name, scopes);
  const { kept, dropped } = dropRedundantScopes(validated.scopes);
  scopes = kept;

  const warnings = wildcardWarnings(scopes);
  if (warnings.length > 0) {
    for (const w of warnings) console.error(w);
    if (!values["allow-wildcard"]) {
      fail("wildcard scopes and presets grant broad access; re-run with --allow-wildcard to confirm. No token created.");
    }
  }
  for (const s of dropped) console.error(`note: dropped redundant scope ${formatScope(s)} (already covered by a wildcard scope)`);

  let expiresInDays: number | undefined;
  const rawDays = values["expires-in-days"];
  if (rawDays !== undefined) {
    if (!/^\d+$/.test(rawDays)) fail("--expires-in-days must be an integer between 1 and 3650");
    expiresInDays = Number(rawDays);
  }

  const created = createToken(name, scopes, { expiresInDays });
  console.log("Token created. The plaintext token is shown ONLY ONCE below — store it now:");
  console.log("");
  console.log(`  id:    ${created.id}`);
  console.log(`  token: ${created.token}`);
  if (created.expires_at) console.log(`  expires_at: ${created.expires_at}`);
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
      .map(formatScope)
      .join(", ");
    console.log(
      [
        `id=${t.id}`,
        `name=${t.name}`,
        `created_at=${t.created_at}`,
        `revoked_at=${t.revoked_at ?? "-"}`,
        `last_used_at=${t.last_used_at ?? "never"}`,
        `expires_at=${t.expires_at ? t.expires_at + (t.expired ? " (EXPIRED)" : "") : "-"}`,
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
