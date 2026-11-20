import { CF_NAMESPACE } from "./naming-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog, parsePrice, syncCloudCapabilities, tokenCostUsd } from "../src/cloud-catalog.js";
import type { CapabilityRegistry } from "../src/capabilities.js";

// Fixture in the catalog's own shape, with generic names.
const FIXTURE = [
  { name: CF_NAMESPACE + "vendor/alpha-chat", task: { name: "Text Generation" }, description: "A chat model.", properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.2, currency: "USD" }, { unit: "per M output tokens", price: 0.3, currency: "USD" }] }] },
  { name: CF_NAMESPACE + "vendor/beta-judge", task: { name: "Text Generation" }, description: "A 9B multimodal decision model that turns a state into decisions.", properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.04, currency: "USD" }, { unit: "per M output tokens", price: 0.01, currency: "USD" }, { unit: "per M cached input tokens", price: 0.004, currency: "USD" }] }] },
  { name: CF_NAMESPACE + "vendor/gamma-system-one", task: { name: "Text Generation" }, description: "A System One-style model.", properties: [] },
  { name: CF_NAMESPACE + "vendor/delta-image", task: { name: "Text-to-Image" }, description: "Images.", properties: [] },
];

test("parseCatalog keeps text models only, classifies decision models from the description, and skips other tasks", () => {
  const models = parseCatalog(FIXTURE);
  assert.deepEqual(models.map((m) => [m.name, m.kind]), [
    [CF_NAMESPACE + "vendor/alpha-chat", "llm"],
    [CF_NAMESPACE + "vendor/beta-judge", "decision"],
    [CF_NAMESPACE + "vendor/gamma-system-one", "decision"],
  ]);
});

test("parsePrice reads per-million rates; a model with no token price is unpriced, not free", () => {
  assert.deepEqual(parsePrice(FIXTURE[1].properties[0].value), { inPerM: 0.04, outPerM: 0.01, cachedInPerM: 0.004 });
  assert.equal(parsePrice([]), undefined);
  assert.equal(parsePrice([{ unit: "per audio minute", price: 0.1, currency: "USD" }]), undefined);
  assert.equal(parseCatalog(FIXTURE)[2].price, undefined, "no price property means unpriced");
});

test("tokenCostUsd uses the per-million rates", () => {
  assert.ok(Math.abs((tokenCostUsd({ inPerM: 0.2, outPerM: 0.3 }, 85, 64) ?? NaN) - (85 * 0.2 + 64 * 0.3) / 1e6) < 1e-15);
});

test("syncCloudCapabilities records every model as recommended, never enabled, and keeps a person's choice", () => {
  const reg: CapabilityRegistry = { hosts: [], capabilities: [] };
  const models = parseCatalog(FIXTURE);
  const first = syncCloudCapabilities(reg, models, "https://api.example/accounts/x", 1);
  assert.deepEqual(first, { added: 3, refreshed: 0 });
  assert.ok(reg.capabilities.every((c) => c.state === "recommended" && c.host === "cloudflare" && c.transport === "cloudflare-workers-ai"));
  assert.equal(reg.capabilities.find((c) => c.model === CF_NAMESPACE + "vendor/beta-judge")?.pricing?.cachedInPerM, 0.004);

  // A person enables one; the next discovery refreshes its price and keeps it enabled.
  const chat = reg.capabilities.find((c) => c.model === CF_NAMESPACE + "vendor/alpha-chat")!;
  chat.state = "enabled";
  const repriced = models.map((m) => (m.name === CF_NAMESPACE + "vendor/alpha-chat" ? { ...m, price: { inPerM: 9, outPerM: 9 } } : m));
  const second = syncCloudCapabilities(reg, repriced, "https://api.example/accounts/x", 2);
  assert.deepEqual(second, { added: 0, refreshed: 3 });
  const after = reg.capabilities.find((c) => c.model === CF_NAMESPACE + "vendor/alpha-chat")!;
  assert.equal(after.state, "enabled", "discovery never changes a person's enable choice");
  assert.equal(after.pricing?.inPerM, 9, "prices always come from the latest catalog");
});
