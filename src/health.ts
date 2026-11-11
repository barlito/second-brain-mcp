// Cheap health helpers shared by /health and the web admin dashboard.
import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "./db";
import { hasRemote, runGit } from "./vault/git";

export function dbOk(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function vaultOk(vaultRoot: string): boolean {
  return existsSync(path.join(vaultRoot, ".git"));
}

export interface BootInfo {
  hasRemote: boolean;
  branch: string;
  head: string;
}

// Filled by initVault (or lazily once), so no health view spawns git per call.
const bootInfo = new Map<string, BootInfo>();

export function setBootInfo(vaultRoot: string, info: BootInfo): void {
  bootInfo.set(path.resolve(vaultRoot), info);
}

// Cached boot facts; computed once (a few git spawns) when initVault did not run (tests).
export async function getBootInfo(vaultRoot: string): Promise<BootInfo | undefined> {
  const key = path.resolve(vaultRoot);
  let info = bootInfo.get(key);
  if (info || !vaultOk(vaultRoot)) return info;
  try {
    info = { hasRemote: await hasRemote(vaultRoot), branch: "", head: "none" };
  } catch {
    return undefined;
  }
  try {
    info.branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], vaultRoot)).trim();
    info.head = (await runGit(["rev-parse", "--short", "HEAD"], vaultRoot)).trim() || "none";
  } catch {
    /* no commits yet */
  }
  bootInfo.set(key, info);
  return info;
}
