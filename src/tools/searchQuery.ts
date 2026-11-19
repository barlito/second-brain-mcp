// Turns free user text into a safe FTS5 MATCH expression: every term is reduced to
// letters and digits and quoted, so nothing the user types is ever FTS syntax.
import { fold } from "./snippet";

export interface SearchTerm {
  text: string; // folded words separated by single spaces
  prefix: boolean;
}

// Lowercase, accent-free, punctuation as spaces: "L’équipe" and "l'equipe" both give "l equipe".
export function words(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseQuery(raw: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const input = raw.replace(/\p{Cc}/gu, " ");
  for (const m of input.matchAll(/["“«]([^"“”«»]*)["”»]|(\S+)/gu)) {
    const quoted = m[1] !== undefined;
    const src = m[1] ?? m[2];
    const text = words(src);
    if (text) terms.push({ text, prefix: !quoted && src.endsWith("*") });
  }
  return terms;
}

export function toMatch(terms: SearchTerm[]): string {
  return terms.map((t) => `"${t.text}"${t.prefix ? "*" : ""}`).join(" ");
}

// Word-boundary match of a term inside text already passed through words().
export function termIn(textWords: string, t: SearchTerm): boolean {
  return ` ${textWords} `.includes(` ${t.text}${t.prefix ? "" : " "}`);
}
