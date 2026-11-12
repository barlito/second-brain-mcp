// MCP server assembly. A fresh McpServer is created per HTTP request (see
// server.ts, stateless Streamable HTTP mode); each tool module registers itself.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegisterTool } from "./tools/common";
import { SERVER_INSTRUCTIONS } from "./tools/conventions";
import { register as registerKbAccess } from "./tools/kbAccess";
import { register as registerKbAppend } from "./tools/kbAppend";
import { register as registerKbArchive } from "./tools/kbArchive";
import { register as registerKbHistory } from "./tools/kbHistory";
import { register as registerKbInitProject } from "./tools/kbInitProject";
import { register as registerKbPropose } from "./tools/kbPropose";
import { register as registerKbRead } from "./tools/kbRead";
import { register as registerKbWrite } from "./tools/kbWrite";
import { register as registerKbList } from "./tools/kbList";
import { register as registerKbSearch } from "./tools/kbSearch";

// Read at runtime (not imported) so tsc rootDir stays src/; resolves to the
// repo-root package.json from both src/ and dist/.
const pkg = require("../package.json") as { name: string; version: string };

// Add new tools here (one line each).
const TOOLS: RegisterTool[] = [
  registerKbRead,
  registerKbWrite,
  registerKbAppend,
  registerKbArchive,
  registerKbList,
  registerKbSearch,
  registerKbHistory,
  registerKbInitProject,
  registerKbPropose,
  registerKbAccess,
];

// `userContext`: optional text appended to the instructions (see userContext.ts).
export function createMcpServer(vaultRoot: string, userContext = ""): McpServer {
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { instructions: userContext ? `${SERVER_INSTRUCTIONS}\n\n${userContext}` : SERVER_INSTRUCTIONS },
  );
  for (const register of TOOLS) register(server, { vaultRoot });
  return server;
}
