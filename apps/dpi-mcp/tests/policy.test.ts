import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, upsertMeshTool } from "../src/tool-store.js";
import { applyPolicy, loadPolicy } from "../src/policy.js";

test("a missing store rebuilt from discovery and policy enables mesh tools and leaves cloud tools off", () => {
  const store = emptyStore();
  upsertMeshTool(store, "studio", "https://studio.example", { id: "local-chat", kind: "llm", aliases: [] }, 1);
  upsertMeshTool(store, "studio", "https://studio.example", { id: "local-judge", kind: "decision", aliases: [] }, 1);
  store.tools.push({
    name: "cloud-chat", source: "cloud", host: "cloud", address: "https://cloud.example", model: "cloud-chat", kind: "llm",
    transport: "cloudflare-workers-ai", family: "cloud-chat", description: "", tags: ["chat"], enabled: true,
    discoveredAt: 1, updatedAt: 1,
  });
  applyPolicy(store, loadPolicy());
  const enabled = store.tools.filter((tool) => tool.enabled).map((tool) => tool.name).sort();
  assert.deepEqual(enabled, ["model_studio_local_chat", "model_studio_local_judge"]);
  assert.equal(store.selectionMode, "ab");
  assert.equal(store.tools.find((tool) => tool.source === "cloud")?.enabled, false);
});
