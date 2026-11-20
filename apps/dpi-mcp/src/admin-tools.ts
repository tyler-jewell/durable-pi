// The admin role's tools. Only a session that presented the admin token is given them (see server.ts): an agent session
// never sees these tools in its list, so it cannot call them.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cfClient, cloudflareSnapshot } from "./cloudflare-snapshot.js";

export function registerAdminTools(server: McpServer, env: NodeJS.ProcessEnv = process.env): void {
  server.registerTool(
    "cloudflare_snapshot",
    {
      title: "Cloudflare snapshot: the whole account in one view, with the last hour's usage and cost",
      description:
        "Every Cloudflare resource the admin token can read (Workers, Durable Objects, R2, KV, D1, Queues, tunnels, Access applications and service tokens, and the DNS records of one zone), the account's billing subscription and rate card, and the last hour's measured requests priced at list price. A part that cannot be read says why. Read only.",
      inputSchema: {
        zone: z.string().min(1).max(253).optional().describe("the zone whose DNS records to count, by name (default: DPI_PRIMARY_ZONE)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const token = env.CLOUDFLARE_ADMIN_TOKEN ?? "";
      const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
      if (!token || !accountId) throw new Error("the admin role needs CLOUDFLARE_ADMIN_TOKEN and CLOUDFLARE_ACCOUNT_ID in the server's environment");
      const snapshot = await cloudflareSnapshot({
        client: cfClient(token),
        accountId,
        zoneName: args.zone ?? env.DPI_PRIMARY_ZONE,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );
}
