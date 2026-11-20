import { QUANT } from "./naming-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPiProfile, headerVarsFor } from "../src/pi-profile.js";
import { emptyStore, type ModelTool, type ToolStore } from "../src/tool-store.js";

const tool = (over: Partial<ModelTool>): ModelTool => ({
  name: "model_alpha_chat", source: "mesh", host: "alpha", address: "https://alpha.example", model: "Alpha-Chat" + QUANT, kind: "llm",
  transport: "openai-compat", family: "alpha-chat", description: "", tags: ["chat"], enabled: true, discoveredAt: 0, updatedAt: 0, ...over,
});
const store = (tools: ModelTool[]): ToolStore => ({ ...emptyStore(), tools });

test("the profile's window is the served window, and an unknown window is skipped and listed, never guessed", () => {
  const s = store([
    tool({ name: "model_alpha_chat", model: "Alpha-Chat" + QUANT, servedContext: 4096 }),
    tool({ name: "model_alpha_other", model: "Beta-Chat" + QUANT, servedContext: undefined }),
  ]);
  const p = buildPiProfile(s, [{ name: "alpha", hostname: "alpha.example", serviceTokenEnv: "CF_ACCESS_ALPHA" }]);
  const models = Object.values(p.models.providers).flatMap((x) => (x as { models: { id: string; contextWindow: number; maxTokens: number }[] }).models);
  assert.deepEqual(models.map((m) => [m.id, m.contextWindow, m.maxTokens]), [["Alpha-Chat" + QUANT, 4096, 2048]]);
  assert.deepEqual(p.skipped.map((x) => x.id), ["model_alpha_other"]);
});

test("disabled tools and decision tools are not in the chat profile", () => {
  const s = store([tool({ enabled: false, servedContext: 4096 }), tool({ name: "model_alpha_judge", kind: "decision", tags: ["decision"], servedContext: 4096 })]);
  assert.deepEqual(Object.keys(buildPiProfile(s, []).models.providers), []);
});

test("headers reference environment variables only; no secret value is written anywhere in the profile", () => {
  const p = buildPiProfile(store([tool({ servedContext: 4096 })]), [{ name: "alpha", hostname: "alpha.example", serviceTokenEnv: "CF_ACCESS_ALPHA" }]);
  const json = JSON.stringify(p.models);
  assert.match(json, /"\$CF_ACCESS_ALPHA_ID"/);
  assert.match(json, /"\$CF_ACCESS_ALPHA_SECRET"/);
  assert.doesNotMatch(p.envSh, /:[a-z0-9]{8,}/i, "env.sh names the variables; it holds no values");
  assert.match(p.envSh, /CF_ACCESS_ALPHA_ID="\$\{CF_ACCESS_ALPHA%%:\*\}"/);
  assert.deepEqual(headerVarsFor("CF_ACCESS_ALPHA"), { id: "CF_ACCESS_ALPHA_ID", secret: "CF_ACCESS_ALPHA_SECRET" });
});

test("provider keys come from the host name, not from a model name", () => {
  const p = buildPiProfile(store([tool({ host: "Macbook Pro", servedContext: 4096 })]), []);
  assert.deepEqual(Object.keys(p.models.providers), ["mesh-macbook-pro"]);
});
