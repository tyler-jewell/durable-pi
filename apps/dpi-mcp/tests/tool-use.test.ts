import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBE_TOOL, PROBE_VALUE, toolUseVerdict } from "../src/model-tools.js";
import type { LlmResult } from "../src/models.js";
import { emptyStore, select, setToolUse, TOOL_USE_TAG, upsertMeshTool, type ModelTool } from "../src/tool-store.js";

const answer = (over: Partial<LlmResult>): LlmResult => ({
  text: "",
  inToks: 1,
  outToks: 1,
  finishReason: "stop",
  truncated: false,
  toolCalls: [],
  toolCallsWithheld: 0,
  maxTokens: 64,
  guarded: true,
  ...over,
});

const call = (name: string, args: string) => ({ id: "c1", name, arguments: args });

test("a structured call to the probe tool with the exact value passes", () => {
  const v = toolUseVerdict(answer({ finishReason: "tool_calls", toolCalls: [call(PROBE_TOOL.name, JSON.stringify({ value: PROBE_VALUE }))] }));
  assert.equal(v.ok, true);
});

test("text in place of a call fails, and says what the model wrote", () => {
  const v = toolUseVerdict(answer({ text: "Tool Call: record_value, value: dpi-probe-7319" }));
  assert.equal(v.ok, false);
  assert.match(v.detail, /no structured call/);
});

test("a call with the wrong value, or to another tool, or with bad JSON, fails", () => {
  assert.equal(toolUseVerdict(answer({ toolCalls: [call(PROBE_TOOL.name, '{"value":"other"}')] })).ok, false);
  assert.equal(toolUseVerdict(answer({ toolCalls: [call("get_weather", '{"city":"Paris"}')] })).ok, false);
  assert.equal(toolUseVerdict(answer({ toolCalls: [call(PROBE_TOOL.name, "{not json")] })).ok, false);
});

test("a cut-off answer is a failure, even when it began a call", () => {
  const v = toolUseVerdict(answer({ truncated: true, finishReason: "length", toolCallsWithheld: 1 }));
  assert.equal(v.ok, false);
  assert.match(v.detail, /cut off/);
});

const chat = (over: Partial<ModelTool>): ModelTool => ({
  name: "model_h_m", source: "mesh", host: "h", address: "http://x", model: "m", kind: "llm", transport: "openai-compat", family: "m",
  description: "", tags: ["chat"], enabled: true, discoveredAt: 0, updatedAt: 0, ...over,
});

test("a pass adds the tool-use tag, a failure removes it, and the check is kept", () => {
  const store = emptyStore();
  store.tools = [chat({ name: "a" })];
  setToolUse(store, "a", { ok: true, checkedAt: 5, detail: "ok" });
  assert.deepEqual(store.tools[0].tags, ["chat", TOOL_USE_TAG]);
  setToolUse(store, "a", { ok: false, checkedAt: 6, detail: "text" });
  assert.deepEqual(store.tools[0].tags, ["chat"]);
  assert.equal(store.tools[0].toolUse?.checkedAt, 6);
});

test("a refresh by discovery keeps a model's tool-use check", () => {
  const store = emptyStore();
  store.tools = [chat({ name: "model_h_m", tags: ["chat", TOOL_USE_TAG], toolUse: { ok: true, checkedAt: 5, detail: "ok" } })];
  upsertMeshTool(store, "h", "http://x", { id: "m", kind: "llm", aliases: [] }, 9);
  assert.equal(store.tools[0].toolUse?.ok, true);
  assert.ok(store.tools[0].tags.includes(TOOL_USE_TAG));
});

test("agent turns that need tool use select only a probed model", () => {
  const store = emptyStore();
  store.tools = [chat({ name: "plain", tags: ["chat"] }), chat({ name: "probed", tags: ["chat", TOOL_USE_TAG] })];
  for (let i = 0; i < 40; i++) assert.equal(select(store, "llm", { requires: ["chat", TOOL_USE_TAG] }).name, "probed");
  store.tools[1].tags = ["chat"];
  assert.throws(() => select(store, "llm", { requires: ["chat", TOOL_USE_TAG] }), /every required tag/);
});
