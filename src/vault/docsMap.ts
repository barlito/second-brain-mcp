// The "## Docs map" of an overview/index: backticked names nested under a backticked section bullet.

interface Entry {
  line: number;
  indent: number;
  token: string;
  top: boolean;
  // "section/note" for a nested name or a slashed token, undefined for a section bullet.
  path?: string;
}

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;

function docsMapEntries(lines: string[]): Entry[] {
  const start = lines.findIndex((l) => /^##\s+docs map\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const out: Entry[] = [];
  const stack: Array<{ indent: number; token: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    const m = /^(\s*)[-*+]\s+`([^`]+)`/.exec(lines[i]);
    if (!m) continue;
    const indent = indentOf(m[1]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    stack.push({ indent, token: m[2] });
    // Only two levels count: section bullets and their direct children.
    const path = stack.length > 2 ? undefined : m[2].includes("/") ? m[2] : parent ? `${parent.token}/${m[2]}` : undefined;
    out.push({ line: i, indent, token: m[2], top: stack.length === 1, path });
  }
  return out;
}

// Note paths the Docs map lists as `section` > `note` ("section/note"); a backticked name with a slash is taken as written.
export function docsMapPaths(indexBody: string): string[] {
  return docsMapEntries(indexBody.split("\n")).flatMap((e) => (e.path ? [e.path] : []));
}

export type DocsMapEdit = { text: string; change: string } | { text?: undefined; change: string };

// Line `i` and the following lines indented deeper (its nested bullets).
function blockEnd(lines: string[], i: number): number {
  const base = indentOf(lines[i]);
  let end = i + 1;
  while (end < lines.length && lines[end].trim() !== "" && !/^#{1,2}\s/.test(lines[end]) && indentOf(lines[end]) > base) end++;
  return end;
}

// Renames `from` ("section/note") to `to` in the Docs map, moving it under the `to` section bullet when
// the section changes. undefined when `from` is not listed; `text` is unset when it cannot be edited.
export function moveDocsMapEntry(indexBody: string, from: string, to: string): DocsMapEdit | undefined {
  const lines = indexBody.split("\n");
  const entries = docsMapEntries(lines);
  const entry = entries.find((e) => e.path === from);
  if (!entry) return undefined;
  const [fromSection] = from.split("/");
  const [toSection, toName] = to.split("/");
  const token = entry.token.includes("/") ? to : toName;
  const renamed = lines[entry.line].replace(`\`${entry.token}\``, `\`${token}\``);
  // Same section, or a `section/note` token written in place: rename on the spot.
  if (fromSection === toSection || entry.token.includes("/")) {
    lines[entry.line] = renamed;
    return { text: lines.join("\n"), change: `renamed \`${from}\` to \`${to}\`` };
  }
  const bullet = entries.find((e) => e.top && e.token === toSection);
  if (!bullet) return { change: `lists \`${from}\` but has no \`${toSection}\` bullet: update it by hand` };

  const end = blockEnd(lines, entry.line);
  const block = [renamed, ...lines.slice(entry.line + 1, end)];
  lines.splice(entry.line, end - entry.line);
  const bulletLine = bullet.line > entry.line ? bullet.line - block.length : bullet.line;
  const at = blockEnd(lines, bulletLine);
  // Indent like the bullet's first child, else two spaces deeper than the bullet.
  const lead = (l: string): string => /^\s*/.exec(l)?.[0] ?? "";
  const pad = at > bulletLine + 1 ? lead(lines[bulletLine + 1]) : lead(lines[bulletLine]) + "  ";
  const reindent = (l: string): string => pad + " ".repeat(Math.max(0, indentOf(l) - entry.indent)) + l.trimStart();
  lines.splice(at, 0, ...block.map(reindent));
  return { text: lines.join("\n"), change: `moved \`${from}\` to \`${to}\`` };
}
