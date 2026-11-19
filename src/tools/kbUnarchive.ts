import { existsSync } from "node:fs";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertSpaceLimits } from "../limits";
import { readFileNoFollow } from "../vault/enumerate";
import { MoveSourceDirtyError, MoveSourceMissingError, MoveTargetExistsError, syncMove } from "../vault/git";
import { isValidSlug, resolveNotePath } from "../vault/paths";
import { INVALID_NAME, kbArgsShape, noteGate, Gate, auditedCall, RegisterTool, registerKbTool, toolError, toolText } from "./common";
import { NoteRuleError, validateNoteContent } from "./conventions";
import { frontmatterMoveIssue } from "./frontmatter";
import { ARCHIVE_SECTION } from "./reserved";
import { MAX_READ_BYTES } from "./kbRead";

const { space: spaceArg, project: projectArg, section: sectionArg, note: noteArg } = kbArgsShape;

export const register: RegisterTool = (server, { vaultRoot }) => {
  registerKbTool(
    server,
    "kb_unarchive",
    {
      description:
        "Move a note out of `archive` back into a section (the reverse of kb_archive). " +
        "Moves <space>/<project>/archive/<archived> to <space>/<project>/<section>/<note> and returns the new location. " +
        "Requires write on <space>:<project>:archive AND write on the destination section. " +
        "Refused: destination in `archive`, an existing note at the destination, notes with uncommitted changes, " +
        "and what a write there would refuse (3 KB cap for overview/index, space limits).",
      inputSchema: {
        space: spaceArg,
        project: projectArg,
        archived: noteArg.describe("Slug of the note inside `archive` (e.g. notes-old-idea)"),
        section: sectionArg.describe("Destination section slug"),
        note: noteArg.describe("Destination note slug (without .md extension)"),
      },
    },
    async ({ space, project, archived, section, note }): Promise<CallToolResult> => {
      const source = { space, project, section: ARCHIVE_SECTION, note: archived };
      const base = noteGate(source, "write", [{ permission: "write", section, detail: "no write on destination section" }]);
      // The destination is not part of the gated target: validate its syntax before any ACL lookup.
      const gate: Gate = (ctx) =>
        !isValidSlug(section) || !isValidSlug(note)
          ? { result: "error", message: INVALID_NAME, detail: "invalid destination slug" }
          : base(ctx);
      return auditedCall("kb_unarchive", source, gate, async (ctx) => {
        const fail = (message: string, detail: string) => ({ toolResult: toolError(message), audit: { detail } });
        if (section === ARCHIVE_SECTION) {
          return fail("Section `archive` is managed by kb_archive and cannot be written directly.", "destination is archive");
        }
        const from = resolveNotePath(vaultRoot, space, project, ARCHIVE_SECTION, archived);
        const to = resolveNotePath(vaultRoot, space, project, section, note);
        if (!existsSync(from)) return fail("Note not found.", "note not found");
        if (existsSync(to)) return fail("A note already exists at the destination.", "destination exists");
        try {
          const { commitSha } = await syncMove(
            vaultRoot,
            from,
            to,
            `kb_unarchive: ${space}/${project}/${section}/${note} via ${ctx.name}`,
            async () => {
              const r = await readFileNoFollow(from, MAX_READ_BYTES);
              if (!r) throw new NoteRuleError("Note is too large to move.", "note too large");
              const issue = frontmatterMoveIssue(section, r.content);
              if (issue) {
                const origin = archived.split("-")[0]; // archive names start with the original section
                throw new NoteRuleError(`Cannot unarchive there: ${issue}. Try section \`${origin}\`.`, "frontmatter mismatch");
              }
              validateNoteContent({ section, note }, r.content);
              assertSpaceLimits(vaultRoot, { space, project, section, note }, r.bytes);
            },
          );
          return {
            toolResult: toolText(`${space}/${project}/${section}/${note}`),
            audit: { gitCommit: commitSha || undefined, detail: `archive/${archived} -> ${section}/${note}` },
          };
        } catch (err) {
          if (err instanceof NoteRuleError) return fail(err.message, err.detail ?? "note rule");
          if (err instanceof MoveSourceMissingError) return fail("Note not found.", "note not found");
          if (err instanceof MoveTargetExistsError) return fail("A note already exists at the destination.", "destination exists");
          if (err instanceof MoveSourceDirtyError) {
            return fail("Note has uncommitted changes in the vault; commit or discard them first.", "uncommitted changes");
          }
          throw err;
        }
      });
    },
  );
};
