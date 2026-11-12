// Note frontmatter: parse, validate and normalize. Server-owned fields (author, created,
// updated) are always set here; the client controls type, sources and extra keys.
// The client's YAML Document is edited in place, so extras survive byte-faithfully
// (`1.10`, `0x1F`, big ints, comments, odd keys such as `__proto__`).
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isScalar, Pair, parseDocument, YAMLMap } from "yaml";
import { ARCHIVE_SECTION } from "./reserved";
import { NoteRuleError } from "./conventions";

export const NOTE_TYPES = ["decision", "convention", "note", "guide", "reference", "gotcha"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const MAX_SOURCES = 20;
export const MAX_SOURCE_CHARS = 500;

// Sections whose notes carry no frontmatter (overview: 3 KB cap; journal: one-liners; archive: moved as-is).
const NO_FRONTMATTER_SECTIONS = new Set(["overview", "journal", ARCHIVE_SECTION]);
// In these sections the type is fixed.
const SECTION_TYPES: Record<string, NoteType> = { decisions: "decision", conventions: "convention" };
const SECTION_TYPE_VALUES = new Set<string>(Object.values(SECTION_TYPES));
// Output key order; every other key follows in its original order.
const KEY_ORDER = ["type", "sources", "author", "created", "updated"];
// Date or ISO datetime (as written by Obsidian properties etc.).
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const hasFrontmatter = (section: string): boolean => !NO_FRONTMATTER_SECTIONS.has(section);
export const defaultType = (section: string): NoteType => SECTION_TYPES[section] ?? "note";
export const isNoteType = (v: unknown): v is NoteType => typeof v === "string" && (NOTE_TYPES as readonly string[]).includes(v);
const validDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);
const validAuthor = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export interface ParsedNote {
  present: boolean;
  doc: Document | null;
  data: Record<string, unknown>;
  body: string;
}

const bad = (msg: string): NoteRuleError => new NoteRuleError(`Invalid frontmatter: ${msg}`, `invalid frontmatter: ${msg}`);

// Numbers are written back exactly as typed (yaml would print 0x1F as 0x1f, drop `+`, `_` ...).
const NUMBER_TAGS = new Set(["tag:yaml.org,2002:int", "tag:yaml.org,2002:float"]);
const keepNumberSource = (tags: any[]): any[] =>
  tags.map((t) =>
    t && NUMBER_TAGS.has(t.tag) && typeof t.stringify === "function"
      ? { ...t, stringify: (node: any, ...rest: any[]) => (typeof node.source === "string" ? node.source : t.stringify(node, ...rest)) }
      : t,
  );

// Frontmatter is a leading `---` fence line (after an optional UTF-8 BOM, which is dropped) up to
// the next `---` line. Throws NoteRuleError when it is malformed or not a mapping. Aliases are
// refused (alias bombs); merge keys are off in YAML 1.2. Big ints stay exact (bigint).
export function parseNote(content: string): ParsedNote {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { present: false, doc: null, data: {}, body: text };
  const rest = text.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) throw bad("missing closing `---` line");
  const yamlText = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const doc = parseDocument(yamlText, { uniqueKeys: true, intAsBigInt: true, customTags: keepNumberSource });
  if (doc.errors.length > 0) throw bad(doc.errors[0].message.split("\n")[0]);
  if (doc.contents === null) return { present: true, doc, data: {}, body };
  if (!isMap(doc.contents)) throw bad("must be a YAML mapping (key: value pairs)");
  try {
    return { present: true, doc, data: doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>, body };
  } catch (err) {
    throw bad((err as Error).message.split("\n")[0]);
  }
}

// Never throws: for readers (search, existing note lookups).
function parseLenient(content: string): ParsedNote | null {
  try {
    return parseNote(content);
  } catch {
    return null;
  }
}

// What kb_search looks at: the body without frontmatter (whole text when it is malformed or the
// section carries none) and the frontmatter type.
export function searchView(section: string, content: string): { body: string; type: NoteType | undefined } {
  if (section === "overview" || section === "journal") return { body: content, type: undefined };
  const p = parseLenient(content);
  if (!p) return { body: content, type: undefined };
  return { body: p.body, type: isNoteType(p.data.type) ? p.data.type : undefined };
}

function validateType(section: string, raw: unknown): NoteType {
  const def = defaultType(section);
  if (raw === undefined || raw === null) return def;
  if (!isNoteType(raw)) throw bad(`type must be one of ${NOTE_TYPES.join(", ")}`);
  if (section in SECTION_TYPES) {
    if (raw !== def) throw bad(`in section \`${section}\` the type must be \`${def}\` (or omitted)`);
  } else if (SECTION_TYPE_VALUES.has(raw)) {
    throw bad(`type \`${raw}\` is reserved for its own section; here use note, guide, reference or gotcha`);
  }
  return raw;
}

function validateSources(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw bad("sources must be a list of strings");
  if (raw.length > MAX_SOURCES) throw bad(`sources has too many items (max ${MAX_SOURCES})`);
  for (const s of raw) {
    if (typeof s !== "string" || s.length < 1 || s.length > MAX_SOURCE_CHARS) {
      throw bad(`each source must be a string of 1-${MAX_SOURCE_CHARS} characters`);
    }
  }
  return raw as string[];
}

const SERVER_FIELDS = ["author", "created", "updated"];
const isCrlf = (s: string): boolean => s.includes("\r\n") && !/(^|[^\r])\n/.test(s);

function mapOf(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
  return doc.contents as YAMLMap;
}

// Key order rule on the YAML map (stable sort), then `---` fenced text in the body's line ending.
function render(doc: Document, body: string, crlf: boolean): string {
  const map = mapOf(doc);
  const rank = (p: Pair): number => {
    const i = KEY_ORDER.indexOf(String(isScalar(p.key) ? p.key.value : p.key));
    return i < 0 ? KEY_ORDER.length : i;
  };
  map.items.sort((a, b) => rank(a as Pair) - rank(b as Pair));
  const fm = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return crlf ? `---\r\n${fm.replace(/\n/g, "\r\n")}---\r\n${body}` : `---\n${fm}---\n${body}`;
}

export interface NormalizeOptions {
  section: string;
  author: string;
  // Today, UTC (YYYY-MM-DD).
  today: string;
  // Current note text (null = new note); supplies `created`, inherited fields and the no-change check.
  existing: string | null;
  // Migration: created/updated from history instead of today.
  dates?: { created: string; updated: string };
}

// Returns the content to store: normalized frontmatter + body. Content WITHOUT frontmatter
// inherits type, sources and extra keys from the existing note (only the body changes);
// content WITH frontmatter replaces them. Returns `existing` itself when body and
// client-controlled fields are unchanged and the server fields are complete (no write, `updated`
// not bumped). Sections without frontmatter pass through verbatim. Throws NoteRuleError.
export function normalizeNote(content: string, o: NormalizeOptions): string {
  if (!hasFrontmatter(o.section)) return content;
  const parsed = parseNote(content);
  const prev = o.existing === null ? null : parseLenient(o.existing);
  const crlf = isCrlf(content);

  let doc: Document;
  if (parsed.present && parsed.doc) doc = parsed.doc;
  else if (prev?.present && prev.doc) doc = prev.doc.clone();
  else doc = new Document({});
  let data = parsed.present ? parsed.data : (prev?.present ? prev.data : {});
  if (!parsed.present && prev?.present) {
    // Inherited values that this section would refuse (hand-edited note) fall back to defaults.
    try {
      validateType(o.section, data.type);
    } catch {
      doc.delete("type");
      data = { ...data, type: undefined };
    }
    try {
      validateSources(data.sources);
    } catch {
      doc.delete("sources");
      data = { ...data, sources: undefined };
    }
  }

  const type = validateType(o.section, data.type);
  const sources = validateSources(data.sources);
  const controlled = (d: Record<string, unknown>): Record<string, unknown> => {
    const { author: _a, created: _c, updated: _u, ...rest } = d;
    return rest;
  };
  const next = { ...controlled(data), type };
  if (data.type === undefined || data.type === null) doc.set("type", type);

  const prevComplete = prev?.present && validAuthor(prev.data.author) && validDate(prev.data.created) && validDate(prev.data.updated);
  if (o.existing !== null && prev && prevComplete && prev.body === parsed.body && isDeepStrictEqual(controlled(prev.data), next)) {
    return o.existing;
  }
  if (sources === undefined) doc.delete("sources");

  const created = prev?.present && validDate(prev.data.created) ? prev.data.created : (o.dates?.created ?? o.today);
  for (const k of SERVER_FIELDS) doc.delete(k);
  doc.set("author", o.author);
  doc.set("created", created);
  doc.set("updated", o.dates?.updated ?? o.today);
  return render(doc, parsed.body, crlf);
}

export interface FillOptions {
  section: string;
  author: string;
  created: string;
  updated: string;
}

// Migration: fills only the server keys a note lacks (type default, author, created, updated);
// existing values, order and body stay. Returns `content` itself when nothing is missing.
export function fillMissingFrontmatter(content: string, o: FillOptions): string {
  if (!hasFrontmatter(o.section)) return content;
  const parsed = parseNote(content);
  if (!parsed.present) {
    return normalizeNote(content, {
      section: o.section,
      author: o.author,
      today: o.updated,
      existing: null,
      dates: { created: o.created, updated: o.updated },
    });
  }
  validateType(o.section, parsed.data.type);
  validateSources(parsed.data.sources);
  const d = parsed.data;
  const missing = [d.type == null, !validAuthor(d.author), !validDate(d.created), !validDate(d.updated)];
  if (!missing.some(Boolean)) return content;
  const doc = parsed.doc as Document;
  if (missing[0]) doc.set("type", defaultType(o.section));
  if (missing[1]) doc.set("author", o.author);
  if (missing[2]) doc.set("created", o.created);
  if (missing[3]) doc.set("updated", o.updated);
  return render(doc, parsed.body, isCrlf(content));
}

export const utcToday = (now = new Date()): string => now.toISOString().slice(0, 10);
