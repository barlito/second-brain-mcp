// Obsidian wikilinks: parsing (with offsets, for rewriting) and resolution against a list of notes.
// Same value as tools/reserved ARCHIVE_SECTION (not imported: that module pulls in the DB).
const ARCHIVE_SECTION = "archive";

export interface WikiLink {
  // "[[target#heading|alias]]" as written (without a leading "!").
  raw: string;
  // Offsets of the whole `[[...]]` in the parsed text.
  start: number;
  end: number;
  // Offsets of the note-name part (before `#` / `|`, trimmed) and its text as written.
  targetStart: number;
  targetEnd: number;
  target: string;
  heading?: string;
  alias?: string;
  embed: boolean;
}

type Range = [number, number];

function frontmatterRange(text: string): Range | undefined {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(text.slice(bom));
  if (!open) return undefined;
  const from = bom + open[0].length;
  const close = /(^|\n)---[ \t]*(\r?\n|$)/.exec(text.slice(from));
  return close ? [0, from + close.index + close[0].length] : undefined;
}

function fencedRanges(text: string): Range[] {
  const out: Range[] = [];
  let fence: { ch: string; len: number; from: number } | undefined;
  let pos = 0;
  for (const raw of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw.replace(/\r$/, ""));
    if (!fence) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { ch: m[1][0], len: m[1].length, from: pos };
    } else if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === "") {
      out.push([fence.from, pos + raw.length]);
      fence = undefined;
    }
    pos += raw.length + 1;
  }
  if (fence) out.push([fence.from, text.length]);
  return out;
}

// Same-length copy of `text` with `ranges` blanked (newlines kept), so offsets stay valid.
function blank(text: string, ranges: Range[]): string {
  let out = "";
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from < at) continue;
    out += text.slice(at, from) + text.slice(from, to).replace(/[^\r\n]/g, " ");
    at = to;
  }
  return out + text.slice(at);
}

function maskIgnored(text: string): string {
  const fm = frontmatterRange(text);
  const masked = blank(text, [...(fm ? [fm] : []), ...fencedRanges(text)]);
  const inline: Range[] = [];
  for (const m of masked.matchAll(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g)) inline.push([m.index, m.index + m[0].length]);
  return blank(masked, inline);
}

// Links outside frontmatter, fenced code blocks and inline code. Offsets refer to `text`.
export function parseLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of maskIgnored(text).matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const inner = m[1];
    const innerStart = m.index + 2;
    const pipe = inner.indexOf("|");
    const targetPart = pipe < 0 ? inner : inner.slice(0, pipe);
    const hash = targetPart.indexOf("#");
    const name = hash < 0 ? targetPart : targetPart.slice(0, hash);
    const target = name.trim();
    if (!target) continue;
    const targetStart = innerStart + (name.length - name.trimStart().length);
    const heading = hash < 0 ? undefined : targetPart.slice(hash + 1).trim();
    out.push({
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      targetStart,
      targetEnd: targetStart + target.length,
      target,
      ...(heading ? { heading } : {}),
      ...(pipe >= 0 ? { alias: inner.slice(pipe + 1).trim() } : {}),
      embed: text[m.index - 1] === "!",
    });
  }
  return out;
}

// The trimmed line containing `offset`.
export function lineAt(text: string, offset: number): string {
  const from = text.lastIndexOf("\n", offset - 1) + 1;
  const to = text.indexOf("\n", offset);
  return text.slice(from, to < 0 ? text.length : to).trim();
}

export interface NoteRef {
  space: string;
  project: string;
  section: string;
  name: string;
}

export type Resolution =
  | { status: "resolved"; note: NoteRef }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: NoteRef[] };

export const noteKey = (n: NoteRef): string => `${n.space}/${n.project}/${n.section}/${n.name}`;

export type LinkResolver = (from: { space: string; project: string }, target: string) => Resolution;

// Resolver over `notes` (archived notes never resolve). A 1-part name is looked up in the
// source's project, then its space, then everywhere: the first level with a match wins.
export function createResolver(notes: NoteRef[]): LinkResolver {
  const byName = new Map<string, NoteRef[]>();
  for (const n of notes) {
    if (n.section === ARCHIVE_SECTION) continue;
    byName.set(n.name, [...(byName.get(n.name) ?? []), n]);
  }
  return (from, target) => {
    const parts = target.trim().toLowerCase().replace(/\.md$/, "").split("/");
    const all = byName.get(parts[parts.length - 1]) ?? [];
    const levels: Array<(n: NoteRef) => boolean> =
      parts.length === 1
        ? [(n) => n.space === from.space && n.project === from.project, (n) => n.space === from.space, () => true]
        : parts.length === 2
          ? [(n) => n.space === from.space && n.project === from.project && n.section === parts[0]]
          : parts.length === 3
            ? [(n) => n.space === from.space && n.project === parts[0] && n.section === parts[1]]
            : parts.length === 4
              ? [(n) => n.space === parts[0] && n.project === parts[1] && n.section === parts[2]]
              : [];
    for (const level of levels) {
      const found = all.filter(level);
      if (found.length === 1) return { status: "resolved", note: found[0] };
      if (found.length > 1) return { status: "ambiguous", candidates: found };
    }
    return { status: "missing" };
  };
}
