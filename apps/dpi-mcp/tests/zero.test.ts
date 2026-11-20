import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesOf, parseSelection, purposeOf, realizedCost, type ModelTest } from "../src/zero.js";
import { familyOf } from "../src/capabilities.js";
import { cloudPriceKnown, marginalElectricityUsd, DEFAULT_SETTINGS } from "../src/meter.js";

test("parseSelection: Enter submits the defaults; numbers toggle; a/n set all or none", () => {
  const defaults = [true, true, false];
  assert.deepEqual(parseSelection("", 3, defaults), defaults);
  assert.deepEqual(parseSelection("  ", 3, defaults), defaults);
  assert.deepEqual(parseSelection("a", 3, defaults), [true, true, true]);
  assert.deepEqual(parseSelection("all", 3, defaults), [true, true, true]);
  assert.deepEqual(parseSelection("n", 3, defaults), [false, false, false]);
  assert.deepEqual(parseSelection("none", 3, defaults), [false, false, false]);
  assert.deepEqual(parseSelection("2", 3, defaults), [true, false, false], "2 toggles an auto-selected model off");
  assert.deepEqual(parseSelection("3,1", 3, defaults), [false, true, true], "comma and space both separate");
});

test("parseSelection: invalid tokens are ignored, so a typo never enables a model", () => {
  assert.deepEqual(parseSelection("0 4 -1 x 1.5", 3, [false, false, false]), [false, false, false]);
});

test("familyOf pairs a local GGUF with its Workers AI twin", () => {
  assert.equal(familyOf("Qwen3-30B-A3B-Q4_K_M"), familyOf("@cf/qwen/qwen3-30b-a3b-fp8"));
  assert.equal(familyOf("Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M"), familyOf("@cf/mistralai/mistral-small-3.1-24b-instruct"));
  assert.equal(familyOf("gpt-oss-20b-MXFP4"), familyOf("@cf/openai/gpt-oss-20b"));
  assert.equal(familyOf("Clef-Flash-Q4_K_M"), familyOf("@cf/cloudflare/clef-flash"));
  assert.equal(familyOf("Qwen3.8-27B-UD-Q4_K_M"), "qwen3.8-27b");
  assert.equal(familyOf("granite-4.0-h-micro-Q4_K_M"), "granite-4.0-h-micro");
});

test("cloudPriceKnown: an unpriced model is unknown, never a zero price", () => {
  assert.equal(cloudPriceKnown("@cf/openai/gpt-oss-20b"), true);
  assert.equal(cloudPriceKnown("@cf/unknown/model"), false);
});

test("marginal electricity is the power above idle, priced per kWh", () => {
  // (80 W - 30 W) for one hour = 0.05 kWh, at $0.15/kWh = $0.0075
  assert.ok(Math.abs(marginalElectricityUsd(3_600_000, DEFAULT_SETTINGS) - 0.0075) < 1e-12);
});

test("realizedCost saves only on priced runs and never guesses an unpriced one", () => {
  const t = (over: Partial<ModelTest>): ModelTest => ({ capability: "c", host: "h", model: "m", kind: "llm", ok: true, ms: 1, inToks: 1, outToks: 1, electricityUsd: 0, sample: "", ...over });
  const r = realizedCost([
    t({ electricityUsd: 0.00005, cloudEquivUsd: 0.00004 }), // priced: local cost more than cloud
    t({ electricityUsd: 0.00001, cloudEquivUsd: 0.00003 }), // priced: local cost less
    t({ electricityUsd: 0.00100 }), // unpriced: counted in electricity, never in savings
  ]);
  assert.equal(r.pricedRuns, 2);
  assert.equal(r.unpricedRuns, 1);
  assert.ok(Math.abs(r.electricityUsd - 0.00106) < 1e-12);
  assert.ok(Math.abs(r.pricedElectricityUsd - 0.00006) < 1e-12);
  assert.ok(Math.abs(r.cloudEquivUsd - 0.00007) < 1e-12);
  assert.ok(Math.abs(r.savedUsd - 0.00001) < 1e-12, "saved = priced cloud minus priced electricity only");
});

test("candidatesOf lists models only from hosts that answered, and purposes follow the kind", () => {
  const cands = candidatesOf([
    { host: { name: "a", hostname: "a.example" }, address: "https://a.example", models: [{ id: "J", kind: "decision", aliases: [] }, { id: "L", kind: "llm", aliases: [] }] },
    { host: { name: "b", hostname: "b.example" }, models: [], error: "access denied (HTTP 401)" },
  ]);
  assert.deepEqual(cands.map((c) => [c.host, c.id, c.kind]), [["a", "J", "decision"], ["a", "L", "llm"]]);
  assert.deepEqual(purposeOf("decision"), ["jev-quality"]);
  assert.deepEqual(purposeOf("llm"), ["agent"]);
});
