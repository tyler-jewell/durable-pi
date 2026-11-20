import { QUANT, CF_NAMESPACE } from "./naming-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesOf, parseSelection, realizedCost, type ModelTest } from "../src/zero.js";
import { kindTags } from "../src/tool-store.js";
import { familyOf } from "../src/models.js";
import { marginalElectricityUsd, DEFAULT_SETTINGS } from "../src/meter.js";
import { tokenCostUsd } from "../src/cloud-catalog.js";

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

test("familyOf pairs a local GGUF with its cloud twin (fixtures are generic on purpose)", () => {
  assert.equal(familyOf("Alpha-Chat-30B-A3B" + QUANT), familyOf(CF_NAMESPACE + "vendor/alpha-chat-30b-a3b-fp8"));
  assert.equal(familyOf("Beta-Chat-24B-Instruct-2503" + QUANT), familyOf(CF_NAMESPACE + "vendor/beta-chat-24b-instruct"));
  assert.equal(familyOf("gamma-chat-20b-MXFP4"), familyOf(CF_NAMESPACE + "vendor/gamma-chat-20b"));
  assert.equal(familyOf("Delta-Judge" + QUANT), familyOf(CF_NAMESPACE + "vendor/delta-judge"));
  assert.equal(familyOf("Epsilon-27B-UD" + QUANT), "epsilon-27b");
  assert.equal(familyOf("solo-model" + QUANT), "solo-model");
});

test("an unpriced model is unknown, never a zero price", () => {
  assert.equal(tokenCostUsd(undefined, 100, 100), undefined);
  assert.equal(tokenCostUsd({ inPerM: 0, outPerM: 0 }, 100, 100), 0, "a price of zero is a price, not unknown");
});

test("marginal electricity is the power above idle, priced per kWh", () => {
  // (80 W - 30 W) for one hour = 0.05 kWh, at $0.15/kWh = $0.0075
  assert.ok(Math.abs(marginalElectricityUsd(3_600_000, DEFAULT_SETTINGS) - 0.0075) < 1e-12);
});

test("realizedCost saves only on priced runs and never guesses an unpriced one", () => {
  const t = (over: Partial<ModelTest>): ModelTest => ({ tool: "t", host: "h", model: "m", kind: "llm", ok: true, ms: 1, inToks: 1, outToks: 1, electricityUsd: 0, sample: "", ...over });
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
  assert.deepEqual(kindTags("decision"), ["decision"]);
  assert.deepEqual(kindTags("llm"), ["chat"]);
});
