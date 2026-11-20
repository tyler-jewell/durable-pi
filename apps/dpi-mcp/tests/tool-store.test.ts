import { QUANT } from "./naming-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, kindTags, select, setEnabled, toolNameOf, upsertMeshTool, type ModelTool } from "../src/tool-store.js";

const tool = (over: Partial<ModelTool>): ModelTool => ({
  name: "t", source: "mesh", host: "h", address: "http://x", model: "m", kind: "llm", transport: "openai-compat", family: "m",
  description: "", tags: ["chat"], enabled: true, discoveredAt: 0, updatedAt: 0, ...over,
});

test("a model's tool name is stable, lowercase, underscores, and at most 64 characters", () => {
  assert.equal(toolNameOf("Studio", "Alpha-Chat-30B" + QUANT), "model_studio_alpha_chat_30b_q4_k_m");
  assert.equal(toolNameOf("h", "x".repeat(200)).length, 64);
  assert.match(toolNameOf("Mac Book", "a/b:c"), /^[a-z0-9_]+$/);
});

test("discovery adds a model disabled, and keeps its enabled state and tags on a refresh", () => {
  const store = emptyStore();
  const m = { id: "Alpha-Judge", kind: "decision" as const, aliases: [] };
  const first = upsertMeshTool(store, "studio", "https://s.example", m, 1);
  assert.equal(first.enabled, false);
  assert.deepEqual(first.tags, kindTags("decision"));
  setEnabled(store, first.name, true, 2);
  const again = upsertMeshTool(store, "studio", "https://s.example", { ...m, servedContext: 4096 }, 3);
  assert.equal(again.enabled, true, "a refresh never changes a person's choice");
  assert.equal(again.servedContext, 4096);
  assert.equal(store.tools.length, 1);
});

test("select: an explicit name is deterministic and checked; a disabled or wrong-kind name is refused", () => {
  const store = emptyStore();
  store.tools = [tool({ name: "a" }), tool({ name: "off", enabled: false }), tool({ name: "j", kind: "decision", tags: ["decision"] })];
  assert.equal(select(store, "llm", { name: "a" }).name, "a");
  assert.throws(() => select(store, "llm", { name: "off" }), /disabled/);
  assert.throws(() => select(store, "llm", { name: "j" }), /decision tool/);
  assert.throws(() => select(store, "llm", { name: "nope" }), /not known/);
});

test("select: A/B picks at random from the enabled tools that carry every required tag", () => {
  const store = emptyStore();
  store.tools = [
    tool({ name: "a", tags: ["chat", "tool-use"] }),
    tool({ name: "b", tags: ["chat", "tool-use"] }),
    tool({ name: "c", tags: ["chat"] }),
    tool({ name: "off", tags: ["chat", "tool-use"], enabled: false }),
  ];
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) seen.add(select(store, "llm", { requires: ["tool-use"] }).name);
  assert.deepEqual([...seen].sort(), ["a", "b"], "only matching, enabled tools are reached");
  const any = new Set<string>();
  for (let i = 0; i < 90; i++) any.add(select(store, "llm").name);
  assert.deepEqual([...any].sort(), ["a", "b", "c"]);
  assert.throws(() => select(store, "llm", { requires: ["vision"] }), /every required tag/);
});

test("select: requiring the mesh source excludes cloud even with a conflicting custom tag", () => {
  const store = emptyStore();
  store.tools = [
    tool({ name: "remote", source: "cloud", kind: "decision", tags: ["mesh", "decision"] }),
    tool({ name: "local", kind: "decision", tags: ["decision"] }),
  ];
  assert.equal(select(store, "decision", { requires: ["mesh", "decision"], random: () => 0 }).name, "local");
  store.tools[1].enabled = false;
  assert.throws(() => select(store, "decision", { requires: ["mesh", "decision"], mode: "auto" }), /no enabled decision tool/);
});

test("select: auto prefers the most recently used mesh tool, with cloud as the fallback", () => {
  const store = emptyStore();
  store.selectionMode = "auto";
  store.tools = [tool({ name: "old", lastUsedAt: 10 }), tool({ name: "recent", lastUsedAt: 20 }), tool({ name: "cloud", source: "cloud", lastUsedAt: 99 })];
  assert.equal(select(store, "llm").name, "recent");
  assert.equal(select(store, "llm", { prefer: "cloud" }).name, "cloud");
  store.tools = store.tools.filter((t) => t.source === "cloud");
  assert.equal(select(store, "llm").name, "cloud", "cloud is the fallback when no mesh tool is enabled");
});
