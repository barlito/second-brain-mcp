// The "## Docs map" of an overview/index: backticked names nested under a backticked section bullet.

// Note paths the Docs map lists as `section` > `note` ("section/note"); a backticked name with a slash is taken as written.
export function docsMapPaths(indexBody: string): string[] {
  const lines = indexBody.split("\n");
  const start = lines.findIndex((l) => /^##\s+docs map\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  const stack: Array<{ indent: number; token: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const m = /^(\s*)[-*+]\s+`([^`]+)`/.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    stack.push({ indent, token: m[2] });
    // Only two levels count: section bullets and their direct children.
    if (stack.length > 2) continue;
    if (m[2].includes("/")) out.push(m[2]);
    else if (parent) out.push(`${parent.token}/${m[2]}`);
  }
  return out;
}
