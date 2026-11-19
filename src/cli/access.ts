#!/usr/bin/env node
// Access-request review CLI for token-less sessions: talks to the server's local admin listener.
import { parseArgs as nodeParseArgs } from "node:util";
import { adminUrl } from "./inbox";

export const USAGE = "usage: access.js <list | approve <id> [--scope s:p:sec:perm,...] [--allow-wildcard (ignored)] | deny <id>>";

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`cannot reach the admin listener at ${base}; is the server running (and ADMIN_PORT correct)?`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function need(r: { status: number; json: any }): any {
  if (r.status >= 200 && r.status < 300) return r.json;
  const lines: string[] = Array.isArray(r.json?.lines) ? r.json.lines : [];
  throw new Error([r.json?.error ?? `admin listener returned HTTP ${r.status}`, ...lines].join("\n"));
}

const fmt = (s: any): string => `${s.space}:${s.project}:${s.section}:${s.permission}`;

// Returns the text to print; throws Error with a clear message on failure.
export async function run(argv: string[], base = adminUrl()): Promise<string> {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    allowPositionals: true,
    options: { scope: { type: "string" }, "allow-wildcard": { type: "boolean" } },
  });
  const ref = (): string => {
    const r = positionals[1];
    if (!r) throw new Error(USAGE);
    return encodeURIComponent(r);
  };
  switch (positionals[0]) {
    case "list": {
      const { requests, sessions } = need(await call(base, "GET", "/admin/access"));
      const out: string[] = [];
      out.push(requests.length === 0 ? "No pending access requests." : "Pending access requests:");
      for (const r of requests) {
        out.push(`${r.id}${r.elevation ? "  ELEVATION" : ""}  ${r.agent ? `agent=${r.agent}  ` : ""}client=${r.client_name} ${r.client_version}  ip=${r.remote_ip ?? "?"}  created=${r.created_at}  scopes=[${r.requested_scopes.map(fmt).join(", ")}]${r.exceeds ? "  SCOPES EXCEED THE STATED REQUEST" : ""}  ${JSON.stringify(r.reason)}`);
      }
      out.push(sessions.length === 0 ? "No active sessions with access." : "Active sessions:");
      for (const s of sessions) {
        out.push(`${s.id}  ${s.agent ? `agent=${s.agent}  ` : ""}client=${s.client_name} ${s.client_version}  last_seen=${s.last_seen_at}  expires=${s.expires_at}  grants=[${s.grants.map((g: any) => `${g.name}: ${g.scopes.map(fmt).join(" ")}`).join("; ")}]`);
      }
      return out.join("\n");
    }
    case "approve": {
      const body: Record<string, unknown> = {};
      if (values.scope) body.scope = values.scope;
      const r = need(await call(base, "POST", `/admin/access/${ref()}/approve`, body));
      return `Approved ${r.space}/${r.project} as ${r.tokenName}: ${r.scopes.map(fmt).join(", ")}${(r.notes as string[]).map((n) => `\nnote: ${n}`).join("")}`;
    }
    case "deny": {
      const r = need(await call(base, "POST", `/admin/access/${ref()}/deny`, {}));
      return `Denied access request for ${r.space}/${r.project}.`;
    }
    default:
      throw new Error(USAGE);
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (out) => console.log(out),
    (err) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
