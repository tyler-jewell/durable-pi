// Prove the mesh provider with real model calls: an agent turn asks for a tool through ask_model, the tool result
// goes back, and the model answers. Needs DPI_MCP_URL and DPI_MCP_TOKEN for a running dpi-mcp server whose enabled
// chat tools serve tool calls. Each turn is metered by that server, so its meter shows the calls.
import assert from "node:assert/strict";
import { normalizeContext, type AssistantMessage, type Context, type Tool } from "@earendil-works/pi-ai";
import { meshProvider } from "../src/mesh-provider.js";

const provider = meshProvider();
const model = provider.getModels()[0];
if (!model) throw Error("the mesh provider lists no model");

const weather: Tool = {
  name: "get_weather",
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const context: Context = {
  systemPrompt: "You are a weather assistant. Use the tools you are given.",
  messages: [{ role: "user", content: "What is the weather in Paris? Call get_weather first, then answer in one sentence.", timestamp: Date.now() }],
  tools: [weather],
};

const turn = (): Promise<AssistantMessage> => provider.streamSimple(model, normalizeContext(context), {}).result();

const first = await turn();
console.log(`turn 1: stop=${first.stopReason} content=${JSON.stringify(first.content).slice(0, 200)}`);
assert.equal(first.stopReason, "toolUse", "the model must ask for the tool");
const call = first.content.find((b) => b.type === "toolCall");
assert.ok(call && call.type === "toolCall", "a tool call is present");
assert.equal(call.name, "get_weather");
assert.deepEqual(call.arguments, { city: "Paris" });

context.messages.push(first);
context.messages.push({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text: "Sunny, 21 °C" }],
  isError: false,
  timestamp: Date.now(),
});

const second = await turn();
const text = second.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
console.log(`turn 2: stop=${second.stopReason} text=${JSON.stringify(text)}`);
assert.equal(second.stopReason, "stop", "the answer must finish");
assert.ok(text.length > 0, "the answer carries text");
assert.match(text, /21|sunny/i, "the answer uses the tool result");
console.log("MESH_AGENT_PASS");
