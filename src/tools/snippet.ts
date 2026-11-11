// Pure helper for kb_search result lines (no I/O, easy to test).
export const MAX_LINE_CHARS = 200;

// Window of at most MAX_LINE_CHARS code points around the first match, cut on
// code-point boundaries, with "…" where text was dropped.
export function snippet(line: string, needle: string): string {
  const t = line.trim();
  const cps = Array.from(t);
  if (cps.length <= MAX_LINE_CHARS) return t;
  const idx = Math.min(Math.max(t.toLowerCase().indexOf(needle), 0), t.length);
  const matchCp = Array.from(t.slice(0, idx)).length;
  const needleCp = Array.from(needle).length;
  let start = Math.max(0, matchCp - Math.floor((MAX_LINE_CHARS - needleCp) / 2));
  const end = Math.min(cps.length, start + MAX_LINE_CHARS);
  start = Math.max(0, end - MAX_LINE_CHARS);
  return (start > 0 ? "…" : "") + cps.slice(start, end).join("") + (end < cps.length ? "…" : "");
}
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
