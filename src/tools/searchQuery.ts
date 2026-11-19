// Turns free user text into a safe FTS5 MATCH expression: every term is quoted,
// so nothing the user types is ever interpreted as FTS syntax.
import { fold } from "./snippet";

export interface SearchTerm {
  text: string; // folded (lowercase, no accents): what lines are compared against
  prefix: boolean;
}

const HAS_WORD = /[\p{L}\p{N}]/u;

export function parseQuery(raw: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  for (const m of raw.matchAll(/"([^"]*)"|(\S+)/g)) {
    const quoted = m[1] !== undefined;
    let text = (m[1] ?? m[2]).replace(/"/g, " ");
    const prefix = !quoted && text.endsWith("*");
    text = text.replace(/\*/g, " ").trim();
    if (HAS_WORD.test(text)) terms.push({ text: fold(text), prefix });
  }
  return terms;
}

export function toMatch(terms: SearchTerm[]): string {
  return terms.map((t) => `"${t.text}"${t.prefix ? "*" : ""}`).join(" ");
}
