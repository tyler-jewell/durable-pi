import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Context } from "@earendil-works/pi-ai";
import { toWire } from "../src/mesh-provider.js";

const weather = { name: "get_weather", description: "Weather", parameters: { type: "object" } };

test("toWire folds the prompt and tools into one leading system message", () => {
  const ctx: Context = {
    systemPrompt: "Be brief.",
    tools: [weather],
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  };
  const { messages, tools } = toWire(normalizeContext(ctx));
  assert.deepEqual(messages[0], { role: "system", content: "Be brief." });
  assert.deepEqual(messages[1], { role: "user", content: "hi" });
  assert.deepEqual(tools, [{ name: "get_weather", description: "Weather", parameters: { type: "object" } }]);
});

test("toWire carries tool calls and their results in OpenAI form", () => {
  const ctx: Context = {
    messages: [
      { role: "user", content: [{ type: "text", text: "weather?" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "get_weather", arguments: { city: "Paris" } }],
        api: "mesh-mcp",
        provider: "mesh",
        model: "chat",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "c1", toolName: "get_weather", content: [{ type: "text", text: "sunny" }], isError: false, timestamp: 3 },
    ],
  };
  const { messages } = toWire(normalizeContext(ctx));
  assert.deepEqual(messages[0], { role: "user", content: "weather?" });
  assert.deepEqual(messages[1].tool_calls, [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]);
  assert.deepEqual(messages[2], { role: "tool", tool_call_id: "c1", name: "get_weather", content: "sunny" });
});

test("toWire refuses image content rather than dropping it", () => {
  const ctx: Context = {
    messages: [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }],
  };
  assert.throws(() => toWire(normalizeContext(ctx)), /accept text only/);
});
