#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "../db";
import { MAX_PRUNE_DAYS, pruneAudit } from "../audit";

// Consistent online backup (safe with WAL). Refuses to overwrite.
export async function backupDb(destPath: string): Promise<string> {
  const dest = resolve(destPath);
  mkdirSync(dirname(dest), { recursive: true });
  // Atomic create-or-fail with 0600; fails with EEXIST instead of overwriting.
  let fd: number;
  try {
    fd = openSync(dest, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`destination already exists: ${dest}`);
    throw err;
  }
  closeSync(fd);
  await db.backup(dest);
  chmodSync(dest, 0o600);
  return dest;
}

export function parseDays(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error("--days must be a non-negative integer");
  }
  const n = Number(raw);
  if (n > MAX_PRUNE_DAYS) throw new Error(`--days must be at most ${MAX_PRUNE_DAYS}`);
  return n;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "backup": {
      const { positionals } = nodeParseArgs({ args: rest, allowPositionals: true });
      if (positionals.length !== 1) fail("usage: maintenance.js backup <destPath>");
      console.log(await backupDb(positionals[0]));
      break;
    }
    case "prune-audit": {
      const { values } = nodeParseArgs({ args: rest, options: { days: { type: "string" } } });
      const n = pruneAudit(parseDays(values.days));
      console.log(`Pruned ${n} audit row(s).`);
      break;
    }
    default:
      fail(`unknown command "${command}". Usage: maintenance.js <backup <destPath>|prune-audit --days <N>>`);
  }
}

if (require.main === module) {
  main().catch((err) => fail((err as Error).message));
}
