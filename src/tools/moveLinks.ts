// Link rewriting for kb_move: each link keeps pointing at the same note once the move is done.
import { LinkResolver, noteKey, NoteRef, parseLinks, splitTarget } from "../vault/links";

type Loc = { space: string; project: string };

const resolvesTo = (resolve: LinkResolver, from: Loc, target: string, note: NoteRef): boolean => {
  const r = resolve(from, target);
  return r.status === "resolved" && noteKey(r.note) === noteKey(note);
};

// Target text for `note` from `from`: `parts` path parts if that resolves uniquely, else the shortest form that does.
export function linkTarget(resolve: LinkResolver, from: Loc, note: NoteRef, parts: number): string {
  const forms = [note.name, `${note.section}/${note.name}`, `${note.project}/${note.section}/${note.name}`, noteKey(note)];
  const wanted = forms[Math.min(Math.max(parts, 1), 4) - 1];
  if (resolvesTo(resolve, from, wanted, note)) return wanted;
  return forms.find((f) => resolvesTo(resolve, from, f, note)) ?? noteKey(note);
}

export interface Rewrite {
  // The note whose text this is, before and after the move (the same for every note but the moved one).
  before: Loc;
  after: Loc;
  // Resolvers over the notes before and after the move.
  resolveBefore: LinkResolver;
  resolveAfter: LinkResolver;
  // The note a link resolving to `n` must point at after the move; undefined = leave it alone.
  retarget: (n: NoteRef) => NoteRef | undefined;
}

// Rewrites only the target part of each link (heading, alias and `!` stay). Code and frontmatter are not links.
export function rewriteLinks(text: string, rw: Rewrite): { text: string; links: number } {
  let out = text;
  let links = 0;
  for (const l of parseLinks(text).reverse()) {
    const r = rw.resolveBefore(rw.before, l.target);
    if (r.status !== "resolved") continue;
    const dest = rw.retarget(r.note);
    if (!dest || resolvesTo(rw.resolveAfter, rw.after, l.target, dest)) continue;
    const target = linkTarget(rw.resolveAfter, rw.after, dest, splitTarget(l.target).length);
    out = out.slice(0, l.targetStart) + target + out.slice(l.targetEnd);
    links++;
  }
  return { text: out, links };
}
