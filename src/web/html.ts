// Tiny HTML template helper with mandatory escaping. Every interpolated value is escaped
// unless it is a SafeHtml (produced by html`` itself, or raw() for vetted markup such as
// sanitised markdown output). Arrays are rendered item by item under the same rule.
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Marks a string as already safe. Only for output of a trusted renderer, never for input.
export const raw = (s: string): SafeHtml => new SafeHtml(s);

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (v === null || v === undefined || v === false || v === true) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}
