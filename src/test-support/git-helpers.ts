import { cloneRepo, makeTempVault } from "./fixtures";

// A vault clone with a seeded bare remote.
export const newVaultWithRemote = () => makeTempVault({ remote: true }) as { vault: string; remote: string };

export function otherClone(remote: string): string {
  return cloneRepo(remote, "other");
}
