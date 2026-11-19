// The reconciliation's pricing: the window rule and the per-call cost, checked against DeepSeek's documented rates
// and against a real call pi recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { callCostUsd, isPeak, type RateCard } from "../scripts/deepseek-reconcile.js";

const card: RateCard = JSON.parse(readFileSync(new URL("../scripts/deepseek-rates.json", import.meta.url), "utf8"));
const utc = (iso: string) => Date.parse(iso);

test("peak window: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; everything else is off-peak", () => {
  assert.equal(isPeak(utc("2026-11-18T02:00:00Z")), true); // Wed 02:00
  assert.equal(isPeak(utc("2026-11-18T07:30:00Z")), true); // Wed 07:30
  assert.equal(isPeak(utc("2026-11-18T09:59:00Z")), true); // Wed 09:59
  assert.equal(isPeak(utc("2026-11-18T10:00:00Z")), false); // end is exclusive
  assert.equal(isPeak(utc("2026-11-18T04:00:00Z")), false); // 04:00 is off-peak
  assert.equal(isPeak(utc("2026-11-18T19:28:00Z")), false); // Wed 19:28
  assert.equal(isPeak(utc("2026-11-21T02:00:00Z")), false); // Saturday, all off-peak
});

test("pi's recorded call (peak rates) reproduces pi's own cost to the last digit", () => {
  // A real pi record: input 4438 (cache miss), cacheRead 768 (cache hit), output 3, pi cost.total 0.005903832.
  const usage = { input: 4438, cacheRead: 768, output: 3 };
  const at = utc("2026-11-18T19:28:34.940Z"); // Wed 19:28 UTC is off-peak, so the peak figure is pi's catalog rate
  const peakCost = callCostUsd("deepseek-v4-pro", usage, utc("2026-11-18T02:00:00Z"), card);
  assert.ok(Math.abs(peakCost - 0.005903832) < 1e-12, `peak ${peakCost}`);
  const offPeakCost = callCostUsd("deepseek-v4-pro", usage, at, card);
  assert.ok(offPeakCost < peakCost, "off-peak is cheaper than pi's peak estimate");
  assert.ok(Math.abs(offPeakCost - (4438 * 0.66 + 768 * 0.022 + 3 * 1.98) / 1e6) < 1e-12);
});

test("a model without a rate is an error, never a silent zero", () => {
  assert.throws(() => callCostUsd("deepseek-unknown", { input: 1, cacheRead: 0, output: 0 }, 0, card), /no rate/);
});

test("the rate card names its source and date", () => {
  assert.match(card.source ?? "", /^https:\/\/api-docs\.deepseek\.com\//);
  assert.match(card.retrieved ?? "", /^\d{4}-\d{2}-\d{2}$/);
});
