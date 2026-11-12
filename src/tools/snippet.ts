// Pure helper for kb_search result lines (no I/O, easy to test).
export const MAX_LINE_CHARS = 200;

// Window of at most MAX_LINE_CHARS code points around the first match, cut on
// code-point boundaries, with "…" where text was dropped. `needle` is lowercase.
export function snippet(line: string, needle: string): string {
  const t = line.trim();
  const cps = Array.from(t);
  if (cps.length <= MAX_LINE_CHARS) return t;
  // Lowercase per code point and remember which original code point produced
  // each lowered code unit: lowercasing can change length (e.g. "İ" -> "i̇"),
  // so an index into t.toLowerCase() is not an index into t.
  let lowered = "";
  const owner: number[] = [];
  cps.forEach((cp, i) => {
    const l = cp.toLowerCase();
    lowered += l;
    for (let k = 0; k < l.length; k++) owner.push(i);
  });
  const at = lowered.indexOf(needle);
  const matchCp = at < 0 ? 0 : owner[at];
  const needleCp = at < 0 ? 0 : owner[at + needle.length - 1] + 1 - matchCp;
  let start = Math.max(0, matchCp - Math.floor((MAX_LINE_CHARS - needleCp) / 2));
  const end = Math.min(cps.length, start + MAX_LINE_CHARS);
  start = Math.max(0, end - MAX_LINE_CHARS);
  return (start > 0 ? "…" : "") + cps.slice(start, end).join("") + (end < cps.length ? "…" : "");
}
