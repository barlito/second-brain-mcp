// MCP server assembly. A fresh McpServer is created per HTTP request (see
// server.ts, stateless Streamable HTTP mode); each tool module registers itself.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegisterTool } from "./tools/common";
import { SERVER_INSTRUCTIONS } from "./tools/conventions";
import { register as registerKbInitProject } from "./tools/kbInitProject";
import { register as registerKbRead } from "./tools/kbRead";
import { register as registerKbWrite } from "./tools/kbWrite";

// Read at runtime (not imported) so tsc rootDir stays src/; resolves to the
// repo-root package.json from both src/ and dist/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { name: string; version: string };

// Add new tools here (one line each).
const TOOLS: RegisterTool[] = [registerKbRead, registerKbWrite, registerKbInitProject];

export function createMcpServer(vaultRoot: string): McpServer {
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const register of TOOLS) register(server, { vaultRoot });
  return server;
}
