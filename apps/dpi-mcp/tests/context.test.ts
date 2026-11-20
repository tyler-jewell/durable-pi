import { test } from "node:test";
import assert from "node:assert/strict";
import { budget, ContextBudgetError, estimateTokens, MIN_OUTPUT_TOKENS, servedContextFromArgs, servedContextFromPreset, servedContextOf } from "../src/context.js";

test("the served window is read from the server's arguments, never the trained length", () => {
  assert.equal(servedContextFromArgs(["llama-server", "--ctx-size", "4096", "--parallel", "1"]), 4096);
  assert.equal(servedContextFromArgs(["llama-server", "--ctx-size=8192"]), 8192);
  assert.equal(servedContextFromArgs(["llama-server", "-c", "16384"]), 16384);
  assert.equal(servedContextFromArgs(["llama-server", "--port", "8080"]), undefined);
  assert.equal(servedContextFromPreset("[m]\nctx-size = 4096\nparallel = 1"), 4096);
  // The trained length (context_length) is 262144 on a served 4096 model: the served value must win.
  assert.equal(servedContextOf({ status: { args: ["x", "--ctx-size", "4096"] } }), 4096);
  assert.equal(servedContextOf({ status: { preset: "ctx-size = 4096" } }), 4096);
  assert.equal(servedContextOf({ status: { args: [] } }), undefined, "no served window is reported as unknown");
});

test("the estimate runs high: it never lets an oversized prompt through", () => {
  const text = "x".repeat(3000);
  assert.ok(estimateTokens(text) >= 1000, "3000 chars is at least 1000 tokens by the conservative rule");
  assert.ok(estimateTokens([{ content: "hi" }, { content: "there" }]) > 4, "each message carries overhead");
});

test("the budget clamps the output to what the window leaves, and refuses a prompt with no room", () => {
  assert.deepEqual(budget(4096, 1000, 2048), { maxTokens: 2048, guarded: true }, "plenty of room: the request is kept");
  assert.deepEqual(budget(4096, 3500, 2048), { maxTokens: 596, guarded: true }, "clamped to the room left");
  assert.throws(() => budget(4096, 4096 - MIN_OUTPUT_TOKENS + 1, 2048), ContextBudgetError, "too little room for any answer");
  assert.deepEqual(budget(undefined, 999999, 2048), { maxTokens: 2048, guarded: false }, "an unknown window is unguarded, and says so");
});
