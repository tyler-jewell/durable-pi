// The factory's connection to the dpi-mcp server. Every model call the factory makes (agent turns and review
// decisions) is an MCP tool call on that server, so its routing, context budget and meter apply to all of them.
// Each call opens its own session and closes it, so no connection outlives the call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface MeshResult {
  structured: unknown;
  isError: boolean;
  text: string;
}

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
};

/** The MCP endpoint and its bearer token, from the environment. Undefined when either is unset. */
export function meshEndpoint(): { url: URL; token: string } | undefined {
  const url = env("DPI_MCP_URL");
  const token = env("DPI_MCP_TOKEN");
  if (!url || !token) return undefined;
  return { url: new URL(url), token };
}

/** Call one tool on the mesh MCP server. Throws when the server is not configured or cannot be reached. */
export async function callMesh(
  name: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MeshResult> {
  const endpoint = meshEndpoint();
  if (!endpoint) throw Error("Mesh models require DPI_MCP_URL and DPI_MCP_TOKEN");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const deadline = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const transport = new StreamableHTTPClientTransport(endpoint.url, {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` }, redirect: "error" },
    fetch: (input, init) => {
      // Closing a session is best effort and must not hold up the call's result.
      const limit = init?.method === "DELETE" ? AbortSignal.timeout(2_000) : deadline;
      return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
    },
  });
  const client = new Client({ name: "dpi-backend", version: "1" });
  try {
    await client.connect(transport, { signal: deadline });
    const r = await client.callTool({ name, arguments: args }, undefined, { signal: deadline });
    const parts = (r.content ?? []) as { type: string; text?: string }[];
    return {
      structured: r.structuredContent,
      isError: r.isError === true,
      text: parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n"),
    };
  } finally {
    if (transport.sessionId) await transport.terminateSession().catch(() => {});
    await client.close();
  }
}
