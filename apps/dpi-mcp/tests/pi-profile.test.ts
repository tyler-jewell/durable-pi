import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPiProfile, headerVarsFor } from "../src/pi-profile.js";
import type { Capability, CapabilityRegistry } from "../src/capabilities.js";

const cap = (over: Partial<Capability>): Capability => ({
  id: "c", name: "m", kind: "llm", host: "alpha", address: "https://alpha.example", model: "Alpha-Chat-Q4_K_M", transport: "openai-compat",
  family: "alpha-chat", description: "", purpose: ["agent"], state: "enabled", autoEnable: true, source: "agent", inputs: [], options: [], createdAt: 0, updatedAt: 0, ...over,
});

test("the profile's window is the served window, and an unknown window is skipped and listed, never guessed", () => {
  const reg: CapabilityRegistry = { hosts: [], capabilities: [cap({ id: "a", model: "Alpha-Chat-Q4_K_M", contextWindow: 4096 }), cap({ id: "b", model: "Beta-Chat-Q4_K_M", contextWindow: undefined })] };
  const p = buildPiProfile(reg, [{ name: "alpha", hostname: "alpha.example", serviceTokenEnv: "CF_ACCESS_ALPHA" }]);
  const models = Object.values(p.models.providers).flatMap((x) => (x as { models: { id: string; contextWindow: number; maxTokens: number }[] }).models);
  assert.deepEqual(models.map((m) => [m.id, m.contextWindow, m.maxTokens]), [["Alpha-Chat-Q4_K_M", 4096, 2048]]);
  assert.deepEqual(p.skipped.map((s) => s.id), ["b"]);
});

test("headers reference environment variables only; no secret value is written anywhere in the profile", () => {
  const reg: CapabilityRegistry = { hosts: [], capabilities: [cap({ contextWindow: 4096 })] };
  const p = buildPiProfile(reg, [{ name: "alpha", hostname: "alpha.example", serviceTokenEnv: "CF_ACCESS_ALPHA" }]);
  const json = JSON.stringify(p.models);
  assert.match(json, /"\$CF_ACCESS_ALPHA_ID"/);
  assert.match(json, /"\$CF_ACCESS_ALPHA_SECRET"/);
  assert.doesNotMatch(p.envSh, /:[a-z0-9]{8,}/i, "env.sh names the variables; it holds no values");
  assert.match(p.envSh, /CF_ACCESS_ALPHA_ID="\$\{CF_ACCESS_ALPHA%%:\*\}"/);
  assert.deepEqual(headerVarsFor("CF_ACCESS_ALPHA"), { id: "CF_ACCESS_ALPHA_ID", secret: "CF_ACCESS_ALPHA_SECRET" });
});

test("provider keys come from the host name, not from a model name", () => {
  const reg: CapabilityRegistry = { hosts: [], capabilities: [cap({ host: "Macbook Pro", contextWindow: 4096 })] };
  const p = buildPiProfile(reg, []);
  assert.deepEqual(Object.keys(p.models.providers), ["mesh-macbook-pro"]);
});
