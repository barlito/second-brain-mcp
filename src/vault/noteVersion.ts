import { createHash } from "node:crypto";

// Git blob SHA-1 of the file bytes (same as `git hash-object`): identifies one exact version of a note.
export function noteVersion(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
