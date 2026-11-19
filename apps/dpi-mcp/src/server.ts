// dpi-mcp: a streamable-HTTP MCP server. Tools: create_app, check, test, push, and
// app-work tools. Bearer-auth with DPI_MCP_TOKEN. Stateful sessions (one transport
// per MCP session) so progress notifications stream over SSE.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.DPI_MCP_PORT ?? 4789);
const HOST = process.env.DPI_MCP_HOST ?? "127.0.0.1";
const TOKEN = process.env.DPI_MCP_TOKEN ?? "";
const NAME = "dpi-mcp";
const VERSION = "0.1.0";

if (!TOKEN || TOKEN.length < 16) {
  console.error(`dpi-mcp: set DPI_MCP_TOKEN (>=16 chars) to authenticate callers.`);
  process.exit(2);
}

const newServer = () => {
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { logging: {} } });
  registerTools(server);
  return server;
};

const app = createMcpExpressApp({ host: HOST });

// Bearer auth on every MCP request.
app.use((req, res, next) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "unauthorized", hint: "set Authorization: Bearer <DPI_MCP_TOKEN>" });
    return;
  }
  next();
});

interface Session {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
}
import type { Response } from "express";

const sessions = new Map<string, Session>();
const track = (session: Session, res: Response) => {
  if (!res.socket || res.socket.destroyed) return;
  session.open++;
  res.on("close", () => {
    session.open--;
    session.lastActive = Date.now();
  });
};

app.all("/mcp", async (req, res) => {
  const sessionId = (req.headers["mcp-session-id"] ?? req.headers["Mcp-Session-Id"]) as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) {
    track(session, res);
    await session.transport.handleRequest(req, res, req.body);
    return;
  }
  if (sessionId) {
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    return;
  }
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const server = newServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  const sid = transport.sessionId;
  if (sid) {
    transport.onclose = () => sessions.delete(sid);
    sessions.set(sid, { transport, open: 0, lastActive: Date.now() });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`dpi-mcp v${VERSION} listening on http://${HOST}:${PORT}/mcp (bearer auth)`);
});
