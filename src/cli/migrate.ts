#!/usr/bin/env node
// Frontmatter migration CLI: asks the server's local admin listener to run it, so it uses the
// server's write lock (a separate process must never run vault operations concurrently).
import http from "node:http";
import { ADMIN_HOST, adminPort } from "../admin";

export const USAGE = "usage: migrate.js frontmatter";

// node:http has no response timeout (fetch would give up after 5 min): a big vault may take a while.
function post(base: string, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": 2 } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json: any = {};
        try {
          json = JSON.parse(raw);
        } catch {
          /* non-JSON body */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

export async function run(argv: string[], base = `http://${ADMIN_HOST}:${adminPort()}`): Promise<string> {
  if (argv[0] !== "frontmatter" || argv.length !== 1) throw new Error(USAGE);
  let r: { status: number; json: any };
  try {
    r = await post(base, "/admin/migrate-frontmatter");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      throw new Error(`cannot reach the admin listener at ${base}; is the server running (and ADMIN_PORT correct)?`);
    }
    throw new Error(
      "connection lost while waiting for the migration; it may still be running or may have committed. " +
        "Check the vault history, then re-run: it is idempotent.",
    );
  }
  const json = r.json;
  if (r.status < 200 || r.status >= 300) throw new Error(json?.error ?? `admin listener returned HTTP ${r.status}`);
  const lines = [json.commit ? `Migrated ${json.migrated} note(s) in commit ${json.commit}.` : "Nothing to migrate (no commit)."];
  for (const s of json.skipped as string[]) lines.push(`skipped ${s}`);
  return lines.join("\n");
}

if (require.main === module) {
  console.error("Migrating (this can take a while on a large vault)...");
  run(process.argv.slice(2)).then(
    (out) => console.log(out),
    (err) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
