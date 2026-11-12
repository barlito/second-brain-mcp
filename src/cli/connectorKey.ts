#!/usr/bin/env node
// Connector key management (direct DB access, like cli/token.ts). The key is printed once, never audited.
import { parseArgs as nodeParseArgs } from "node:util";
import { CONNECTOR_HEADER, ConnectorKeyError, createConnectorKey, listConnectorKeys, revealConnectorKey, revokeConnectorKey } from "../auth/connectorKeys";
import { mcpUrl } from "../mcpCommand";
import { safeAudit } from "../tools/common";

const ACTOR = "cli";
const audit = (action: string, result: "ok" | "error", detail: string): void => safeAudit({ tokenId: ACTOR, tokenName: ACTOR, action, result, detail }, ACTOR);

// Returns the text to print; throws Error with a clear message on failure.
export function run(argv: string[]): string {
  const { values, positionals } = nodeParseArgs({ args: argv, allowPositionals: true, options: { name: { type: "string" }, id: { type: "string" } } });
  switch (positionals[0]) {
    case "create": {
      let c;
      try {
        c = createConnectorKey(values.name, process.env.ADMIN_WEB_SECRET || undefined);
      } catch (err) {
        if (err instanceof ConnectorKeyError) throw new Error(err.message);
        throw err;
      }
      audit("admin_connector_key_create", "ok", `${c.id} ${c.name}`);
      const cmd = `claude mcp add --scope user --transport http second-brain ${mcpUrl()} --header "${CONNECTOR_HEADER}: ${c.key}"`;
      return [
        "Connector key created (`make connector-key-show name=...` shows it again):",
        "",
        `  id:     ${c.id}`,
        `  header: ${CONNECTOR_HEADER}: ${c.key}`,
        "",
        "claude.ai: custom connector, Authentication none, add the request header above (required).",
        "Claude Code:",
        cmd,
      ].join("\n");
    }
    case "list": {
      const keys = listConnectorKeys();
      if (keys.length === 0) return "No connector keys (token-less access is disabled).";
      return keys.map((k) => `id=${k.id}  name=${k.name}  created_at=${k.created_at}  revoked_at=${k.revoked_at ?? "-"}  last_used_at=${k.last_used_at ?? "never"}`).join("\n");
    }
    case "show": {
      const ref = values.id ? { id: values.id } : values.name ? { name: values.name } : undefined;
      if (!ref) throw new Error("--name or --id is required");
      const r = revealConnectorKey(ref, process.env.ADMIN_WEB_SECRET || undefined);
      audit("connector_key_reveal", r.status === "ok" ? "ok" : "error", `${values.id ?? values.name} ${r.status}`);
      if (r.status === "missing") throw new Error("no such active connector key");
      if (r.status === "ambiguous") throw new Error(`several active keys are named "${values.name}": ambiguous name, use --id (see list)`);
      if (r.status === "undecryptable") throw new Error("cannot decrypt this key (ADMIN_WEB_SECRET changed, or it was created without one): create a new key. It still works as is.");
      return `id:     ${r.id}\nheader: ${CONNECTOR_HEADER}: ${r.key}`;
    }
    case "revoke": {
      if (!values.id) throw new Error("--id is required");
      const r = revokeConnectorKey(values.id);
      audit("admin_connector_key_revoke", r.revoked ? "ok" : "error", r.revoked ? `${values.id} ended ${r.sessions} session(s)` : `${values.id} not found or already revoked`);
      if (!r.revoked) throw new Error(`connector key ${values.id} not found (or already revoked)`);
      return `Connector key ${values.id} revoked, ${r.sessions} session(s) ended.`;
    }
    default:
      throw new Error("usage: connectorKey.js <create --name N | show --name N|--id ID | list | revoke --id ID>");
  }
}

if (require.main === module) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
