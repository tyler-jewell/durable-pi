import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUsage, DEFAULT_SETTINGS, type UsageMeter } from "../src/meter.js";

const mk = (calls: UsageMeter["calls"], settings = DEFAULT_SETTINGS): UsageMeter => ({ startedAt: 0, calls, settings: { ...settings } });

test("computeUsage: one call bills idle + load power for its duration", () => {
  const s = computeUsage(mk([{ startedAt: 0, endedAt: 1000, model: "m", kind: "llm" }]), 1000);
  assert.equal(s.loadSeconds, 1);
  // 30 W idle x 1s + (80-30) W load x 1s = 80 J
  assert.ok(Math.abs(s.kwh - 80 / 3_600_000) < 1e-12);
  assert.equal(s.costUsd, s.kwh * 0.15);
});

test("computeUsage: concurrent calls share the load — the union, not the sum", () => {
  const s = computeUsage(
    mk([
      { startedAt: 0, endedAt: 2000, model: "a", kind: "llm" },
      { startedAt: 1000, endedAt: 3000, model: "b", kind: "llm" },
    ]),
    3000,
  );
  assert.equal(s.loadSeconds, 3); // [0,3000] union, not 2 + 2
});

test("computeUsage: idle power accrues even with no calls", () => {
  const s = computeUsage(mk([]), 3_600_000); // one idle hour
  assert.equal(s.loadSeconds, 0);
  assert.ok(Math.abs(s.kwh - (30 * 3600) / 3_600_000) < 1e-12);
});

test("computeUsage: cost scales with the configured price", () => {
  const s = computeUsage(mk([]), 3_600_000);
  assert.equal(s.settings.electricityUsdPerKwh, 0.15);
  assert.equal(s.costUsd, s.kwh * 0.15);
});
