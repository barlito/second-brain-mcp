import { existsSync } from "node:fs";
import { resolveNotePath } from "../vault/paths";
import { MoveSourceDirtyError, MoveSourceMissingError, MoveTargetExistsError, syncMove } from "../vault/git";
import { ARCHIVE_SECTION } from "./reserved";

const MAX_SLUG = 64;
const MAX_ATTEMPTS = 50;

// n=1 -> "<stem>", n>=2 -> "<stem>-<n>"; the stem is truncated to stay a valid slug.
export function archiveName(section: string, note: string, n: number): string {
  const suffix = n === 1 ? "" : `-${n}`;
  const stem = `${section}-${note}`.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "");
  return stem + suffix;
}

export type ArchiveOutcome =
  | { ok: true; name: string; commitSha: string }
  | { ok: false; message: string; detail: string };

const fail = (message: string, detail: string): ArchiveOutcome => ({ ok: false, message, detail });

// Shared by kb_archive and the web admin. Call after the ACL check; slugs must be valid.
// The move goes through syncMove, i.e. the serialized write lock.
export async function archiveNote(
  vaultRoot: string,
  t: { space: string; project: string; section: string; note: string },
  commitMessage: string,
): Promise<ArchiveOutcome> {
  const { space, project, section, note } = t;
  if (section === ARCHIVE_SECTION) return fail("Note is already archived.", "already in archive");
  if (section === "overview" && note === "index") {
    return fail("The project entry note (overview/index) cannot be archived.", "entry note");
  }
  const from = resolveNotePath(vaultRoot, space, project, section, note);
  if (!existsSync(from)) return fail("Note not found.", "note not found");

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const name = archiveName(section, note, n);
    const to = resolveNotePath(vaultRoot, space, project, ARCHIVE_SECTION, name);
    if (existsSync(to)) continue;
    try {
      const { commitSha } = await syncMove(vaultRoot, from, to, commitMessage);
      return { ok: true, name, commitSha };
    } catch (err) {
      if (err instanceof MoveTargetExistsError) continue; // lost a race: next name
      if (err instanceof MoveSourceMissingError) return fail("Note not found.", "note not found");
      if (err instanceof MoveSourceDirtyError) {
        return fail("Note has uncommitted changes in the vault; commit or discard them first.", "uncommitted changes");
      }
      throw err;
    }
  }
  return fail("Too many archived notes with this name.", "no free archive name");
}
