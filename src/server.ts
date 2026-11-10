import express, { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyToken } from "./auth/tokens";
import { tokenContextStorage } from "./auth/context";
import { createMcpServer } from "./mcp";

const vaultRoot = process.env.VAULT_PATH;
if (!vaultRoot) {
  throw new Error("VAULT_PATH environment variable is required");
}

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(express.json());

// Bearer-token auth, mounted before the MCP route. No MCP involved on failure.
function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match) {
    res.status(401).json({ error: "missing or malformed Authorization header" });
    return;
  }

  const verified = verifyToken(match[1]);
  if (!verified) {
    res.status(401).json({ error: "invalid or revoked token" });
    return;
  }

  tokenContextStorage.run(
    { tokenId: verified.tokenId, name: verified.name, scopes: verified.scopes },
    next,
  );
}

app.use("/mcp", bearerAuth);

// Stateless Streamable HTTP mode: a fresh McpServer + transport per request,
// no session state kept between calls (matches the SDK's own
// simpleStatelessStreamableHttp example).
app.post("/mcp", async (req, res) => {
  const server = createMcpServer(vaultRoot);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support SSE streams or session termination.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

export { app };

// Guard so this module can be imported for testing (same pattern as
// cli/token.ts) without binding a real port — tests mount `app` themselves
// on an ephemeral port.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`second-brain-mcp listening on port ${port}`);
  });
}
