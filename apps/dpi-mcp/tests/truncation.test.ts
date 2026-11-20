// A cut-off answer is never presented as complete. These tests pin that rule on the real transport code,
// against a mock OpenAI-compatible server that returns each finish reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { finishOf, runLlm } from "../src/models.js";

test("finishOf: known reasons pass through; anything unknown is 'other', never silently 'stop'", () => {
  assert.equal(finishOf("stop"), "stop");
  assert.equal(finishOf("length"), "length");
  assert.equal(finishOf("tool_calls"), "tool_calls");
  assert.equal(finishOf("content_filter"), "other");
  assert.equal(finishOf(undefined), "other");
});

test("runLlm flags an answer that hit the output limit, and only that one", async () => {
  let reason: string | undefined = "length";
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "partial" }, finish_reason: reason }], usage: { prompt_tokens: 3, completion_tokens: 2048 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cut = await runLlm(base, "any", [{ role: "user", content: "x" }]);
    assert.equal(cut.finishReason, "length");
    assert.equal(cut.truncated, true, "a length stop is a cut-off answer");
    assert.equal(cut.outToks, 2048);

    reason = "stop";
    const whole = await runLlm(base, "any", [{ role: "user", content: "x" }]);
    assert.equal(whole.truncated, false);

    reason = undefined;
    const unknown = await runLlm(base, "any", [{ role: "user", content: "x" }]);
    assert.equal(unknown.finishReason, "other");
    assert.equal(unknown.truncated, false, "an unknown reason is not the same as a cut-off, but it is never 'stop'");
  } finally {
    server.close();
  }
});
