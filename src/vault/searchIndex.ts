// In-memory FTS5 index of every note, rebuilt at startup and kept current from git
// diffs. It knows nothing about tokens: callers apply the ACL to what they read.
import Database from "better-sqlite3";
import path from "node:path";
import { listNoteNames, listSubdirs, readFileNoFollow } from "./enumerate";
import { runGit, setVaultIndexer } from "./git";
import { isValidSlug } from "./paths";
import { searchView } from "../tools/frontmatter";

export const MAX_INDEXED_BYTES = 1024 * 1024;

export interface IndexedHit {
  rowid: number;
  path: string;
}

export interface SearchFilter {
  space?: string;
  project?: string;
  section?: string;
  type?: string;
}

const indexes = new Map<string, SearchIndex>();

export function getSearchIndex(vaultRoot: string): SearchIndex | undefined {
  return indexes.get(vaultRoot);
}

// Registers the index and fills it in the background; never rejects.
export function startSearchIndex(vaultRoot: string): SearchIndex {
  const idx = new SearchIndex(vaultRoot);
  indexes.set(vaultRoot, idx);
  setVaultIndexer(vaultRoot, () => idx.sync());
  void idx.build().catch((err) => console.error(`search index build failed: ${err instanceof Error ? err.message : String(err)}`));
  return idx;
}

export function dropSearchIndex(vaultRoot: string): void {
  indexes.get(vaultRoot)?.close();
  indexes.delete(vaultRoot);
  setVaultIndexer(vaultRoot, null);
}

export class SearchIndex {
  private db = new Database(":memory:");
  private pending = new Set<string>();
  private building = false;
  ready = false;

  constructor(private vaultRoot: string) {
    // name and body first: bm25 weights follow column order.
    this.db.exec(
      "CREATE VIRTUAL TABLE notes USING fts5(name, body, path UNINDEXED, space UNINDEXED, project UNINDEXED, section UNINDEXED, type UNINDEXED, tokenize='unicode61 remove_diacritics 2')",
    );
  }

  close(): void {
    this.db.close();
  }

  // HEAD the index is known to match; undefined until the build has started.
  private lastHead: string | undefined;

  async build(): Promise<void> {
    this.building = true;
    try {
      this.lastHead = await this.head();
      for (const space of await listSubdirs(this.vaultRoot, [])) {
        for (const project of await listSubdirs(this.vaultRoot, [space])) {
          for (const section of await listSubdirs(this.vaultRoot, [space, project])) {
            try {
              const names = await listNoteNames(this.vaultRoot, [space, project, section]);
              await this.reindex(names.map((n) => `${space}/${project}/${section}/${n}.md`));
            } catch (err) {
              console.error(`search index: skipped ${space}/${project}/${section}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      // Changes that arrived during the build are applied before readiness flips.
      while (this.pending.size) {
        const rels = [...this.pending];
        this.pending.clear();
        await this.reindex(rels);
      }
      this.ready = true;
    } finally {
      // A failed build leaves ready=false (kb_search keeps the scan) and drops the queue.
      this.building = false;
      this.pending.clear();
    }
  }

  private async head(): Promise<string> {
    return (await runGit(["rev-parse", "HEAD"], this.vaultRoot).catch(() => "")).trim();
  }

  // Reindexes what changed between the last-seen HEAD and HEAD. The marker only advances after
  // a successful update, so a failed diff is retried on the next turn. Never throws.
  async sync(): Promise<void> {
    try {
      const last = this.lastHead;
      if (last === undefined) return;
      const now = await this.head();
      if (now === last || !now) return;
      const out = last
        ? await runGit(["diff", "--name-only", "--no-renames", "-z", last, now], this.vaultRoot)
        : await runGit(["ls-tree", "-r", "--name-only", "-z", now], this.vaultRoot);
      await this.update(out.split("\0").filter(Boolean));
      this.lastHead = now;
    } catch (err) {
      console.error(`search reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // rels are vault-relative file paths; a missing or unreadable file is removed from the index.
  async update(rels: string[]): Promise<void> {
    if (this.building) rels.forEach((r) => this.pending.add(r));
    else await this.reindex(rels);
  }

  private async reindex(rels: string[]): Promise<void> {
    const rows: Array<[string, string, string, string, string, string, string]> = [];
    const gone: string[] = [];
    for (const rel of rels) {
      const parts = rel.split("/");
      if (parts.length !== 4 || !parts[3].endsWith(".md") || !parts.slice(0, 3).every(isValidSlug)) continue;
      const name = parts[3].slice(0, -3);
      if (!isValidSlug(name)) continue;
      gone.push(rel.slice(0, -3));
      try {
        const r = await readFileNoFollow(path.join(this.vaultRoot, rel), MAX_INDEXED_BYTES);
        if (!r) continue;
        const view = searchView(parts[2], r.content);
        rows.push([name, view.body, rel.slice(0, -3), parts[0], parts[1], parts[2], view.type ?? ""]);
      } catch {
        /* vanished or symlinked: stays removed */
      }
    }
    const del = this.db.prepare("DELETE FROM notes WHERE path IN (SELECT value FROM json_each(?))");
    const ins = this.db.prepare("INSERT INTO notes (name, body, path, space, project, section, type) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      del.run(JSON.stringify(gone));
      for (const row of rows) ins.run(...row);
    })();
  }

  // Ranked notes for a prepared MATCH expression (name weighted over body); the caller filters by ACL.
  *search(match: string, f: SearchFilter): IterableIterator<IndexedHit> {
    const where = ["notes MATCH ?"];
    const args: string[] = [`{name body} : (${match})`];
    for (const k of ["space", "project", "section", "type"] as const) {
      if (f[k] !== undefined) {
        where.push(`${k} = ?`);
        args.push(f[k]);
      }
    }
    const stmt = this.db.prepare(
      `SELECT rowid, path FROM notes WHERE ${where.join(" AND ")} ORDER BY bm25(notes, 10.0, 1.0), path`,
    );
    yield* stmt.iterate(...args) as IterableIterator<IndexedHit>;
  }

  body(rowid: number): string {
    return (this.db.prepare("SELECT body FROM notes WHERE rowid = ?").get(rowid) as { body: string } | undefined)?.body ?? "";
  }
}
