import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { runLlm } from "../src/models.js";

/** A chat endpoint that records the request and answers with the given choice. */
async function fake(choice: Record<string, unknown>) {
  const seen: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { address, seen, close: () => server.close() };
}

const weather = { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } };

test("runLlm sends tools and returns the tool calls the model made", async () => {
  const f = await fake({
    finish_reason: "tool_calls",
    message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
  });
  try {
    const r = await runLlm(f.address, "m", [{ role: "user", content: "weather?" }], { tools: [weather], toolChoice: "required" });
    assert.deepEqual(r.toolCalls, [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }]);
    assert.equal(r.truncated, false);
    const sent = f.seen[0] as { tools: { type: string; function: { name: string } }[]; tool_choice: string };
    assert.equal(sent.tools[0].type, "function");
    assert.equal(sent.tools[0].function.name, "get_weather");
    assert.equal(sent.tool_choice, "required");
  } finally {
    f.close();
  }
});

test("runLlm sends a tool result back as a tool message", async () => {
  const f = await fake({ finish_reason: "stop", message: { content: "It is sunny." } });
  try {
    const messages = [
      { role: "user" as const, content: "weather?" },
      { role: "assistant" as const, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool" as const, tool_call_id: "call_1", name: "get_weather", content: "sunny" },
    ];
    const r = await runLlm(f.address, "m", messages, { tools: [weather] });
    assert.equal(r.text, "It is sunny.");
    assert.deepEqual(r.toolCalls, []);
    const sent = f.seen[0] as { messages: { role: string; tool_call_id?: string }[] };
    assert.equal(sent.messages[2].role, "tool");
    assert.equal(sent.messages[2].tool_call_id, "call_1");
  } finally {
    f.close();
  }
});

test("a truncated answer withholds its tool calls", async () => {
  const f = await fake({
    finish_reason: "length",
    message: { content: "", tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Pa' } }] },
  });
  try {
    const r = await runLlm(f.address, "m", [{ role: "user", content: "weather?" }], { tools: [weather] });
    assert.equal(r.truncated, true);
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.toolCallsWithheld, 1);
  } finally {
    f.close();
  }
});
