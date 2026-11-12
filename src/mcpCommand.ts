// Ready-to-paste `claude mcp add` command shown once after a token is created (CLI and web).
// The command embeds the token: callers print/render it and never log or persist it.

export const DEFAULT_MCP_URL = "https://second-brain.barlito.fr/mcp";
export const MAX_DIR_LENGTH = 512;

// PUBLIC_MCP_URL when it is a clean http(s) URL, else the default (with a warning).
export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_MCP_URL?.trim();
  if (!raw) return DEFAULT_MCP_URL;
  try {
    const u = new URL(raw);
    if ((u.protocol === "http:" || u.protocol === "https:") && !/[\s"'`\\]/.test(raw)) return raw;
  } catch {
    /* falls through */
  }
  console.error(`warning: PUBLIC_MCP_URL is not a valid http(s) URL; using ${DEFAULT_MCP_URL}`);
  return DEFAULT_MCP_URL;
}

// POSIX single-quote quoting; plain strings of safe characters stay unquoted.
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Error message when `dir` cannot be quoted into a one-line command; undefined when fine.
export function dirProblem(dir: string): string | undefined {
  if (dir.length > MAX_DIR_LENGTH) return `local directory is too long (max ${MAX_DIR_LENGTH} characters)`;
  if (/[\x00-\x1f\x7f]/.test(dir)) return "local directory must not contain control characters or newlines";
  return undefined;
}

// A leading ~ stays outside the quotes so the shell still expands it.
function cdTarget(dir: string): string {
  if (dir === "~") return "~";
  if (dir.startsWith("~/")) return dir.length === 2 ? "~/" : `~/${shellQuote(dir.slice(2))}`;
  return shellQuote(dir);
}

export function claudeAddCommand(opts: { url: string; token: string; dir?: string }): string {
  const dir = opts.dir?.trim();
  if (dir) {
    const p = dirProblem(dir);
    if (p) throw new Error(p);
  }
  const add = `claude mcp add --scope local --transport http second-brain ${shellQuote(opts.url)} --header "Authorization: Bearer ${opts.token}"`;
  return dir ? `cd ${cdTarget(dir)} && ${add}` : add;
}
