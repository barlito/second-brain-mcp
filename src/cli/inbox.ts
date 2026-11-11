#!/usr/bin/env node
// Inbox review CLI: talks to the server's local admin listener (never touches git itself).
import { parseArgs as nodeParseArgs } from "node:util";
import { isValidInboxId } from "../inbox";

export const USAGE = "usage: inbox.js <list | show <id> | accept <id> [--overwrite] | reject <id>>";

export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${env.ADMIN_PORT || 3001}`;
}

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
  throw new Error(r.json?.error ?? `admin listener returned HTTP ${r.status}`);
}

function idArg(positionals: string[]): string {
  const id = positionals[1];
  if (!id) throw new Error(USAGE);
  if (!isValidInboxId(id)) throw new Error(`invalid proposal id "${id}"`);
  return id;
}

// Returns the text to print; throws Error with a clear message on failure.
export async function run(argv: string[], base = adminUrl()): Promise<string> {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    allowPositionals: true,
    options: { overwrite: { type: "boolean" } },
  });
  switch (positionals[0]) {
    case "list": {
      const { proposals } = need(await call(base, "GET", "/admin/inbox"));
      if (proposals.length === 0) return "Inbox is empty.";
      return proposals
        .map((p: any) => `${p.id}  ${p.target ?? "(malformed)"}  by=${p.proposed_by ?? "?"}  ${p.size}B  ${JSON.stringify(p.reason ?? "")}`)
        .join("\n");
    }
    case "show": {
      const p = need(await call(base, "GET", `/admin/inbox/${idArg(positionals)}`));
      return `id:          ${p.id}\ntarget:      ${p.target}\nproposed_by: ${p.proposed_by}\ncreated:     ${p.created}\nreason:      ${p.reason}\n\n${p.content}`;
    }
    case "accept": {
      const r = need(await call(base, "POST", `/admin/inbox/${idArg(positionals)}/accept`, { overwrite: values.overwrite === true }));
      return `Accepted into ${r.target} (commit ${r.commit}).`;
    }
    case "reject": {
      const r = need(await call(base, "POST", `/admin/inbox/${idArg(positionals)}/reject`, {}));
      return `Rejected proposal for ${r.target} (commit ${r.commit}).`;
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
