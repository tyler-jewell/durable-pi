import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAdminTools } from "../src/admin-tools.js";
import { registerTools } from "../src/tools.js";
import { ModelTools } from "../src/model-tools.js";
import { emptyStore } from "../src/tool-store.js";

/** A stand-in server that records each tool name it is asked to register, and the handler it gives it. */
function recorder() {
  const names: string[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      names.push(name);
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, names, handlers };
}

test("the admin tools are registered only on the admin path, never with the agent tools", () => {
  const agent = recorder();
  registerTools(agent.server, new ModelTools(() => emptyStore()));
  assert.equal(agent.names.includes("cloudflare_snapshot"), false, "an agent session must not see the snapshot");

  const admin = recorder();
  registerAdminTools(admin.server, {});
  assert.deepEqual(admin.names, ["cloudflare_snapshot"]);
});

test("the snapshot refuses to run without its admin token and account", async () => {
  const r = recorder();
  registerAdminTools(r.server, {});
  const handler = r.handlers.get("cloudflare_snapshot")!;
  await assert.rejects(() => handler({}), /CLOUDFLARE_ADMIN_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
});
