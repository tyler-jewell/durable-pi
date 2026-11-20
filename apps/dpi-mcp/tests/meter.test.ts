import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudCostUsd, compareCosts, computeUsage, DEFAULT_SETTINGS, type UsageMeter, type UsageRecord } from "../src/meter.js";

const call = (o: Partial<UsageRecord> & { startedAt: number; endedAt: number; model: string; kind: "llm" | "decision" }): UsageRecord => ({
  transport: "openai-compat",
  inToks: 0,
  outToks: 0,
  costUsd: 0,
  ...o,
});

const mk = (calls: UsageRecord[], settings = DEFAULT_SETTINGS): UsageMeter => ({ startedAt: 0, calls, settings: { ...settings } });

test("computeUsage: one call bills idle + load power for its duration", () => {
  const s = computeUsage(mk([call({ startedAt: 0, endedAt: 1000, model: "m", kind: "llm" })]), 1000);
  assert.equal(s.loadSeconds, 1);
  // 30 W idle x 1s + (80-30) W load x 1s = 80 J
  assert.ok(Math.abs(s.kwh - 80 / 3_600_000) < 1e-12);
  assert.equal(s.costUsd, s.kwh * 0.15);
});

test("computeUsage: concurrent calls share the load — the union, not the sum", () => {
  const s = computeUsage(
    mk([
      call({ startedAt: 0, endedAt: 2000, model: "a", kind: "llm" }),
      call({ startedAt: 1000, endedAt: 3000, model: "b", kind: "llm" }),
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

test("cloudCostUsd: tokens x catalog price", () => {
  assert.equal(cloudCostUsd("@cf/openai/gpt-oss-20b", 85, 64), (85 * 0.2 + 64 * 0.3) / 1_000_000);
  assert.equal(cloudCostUsd("unknown", 1, 1), 0);
});

test("compareCosts: cloud rate and local opportunity cost, credited when local is faster", () => {
  const m = mk([
    // cloud twin: 60s, $0.60 billable → $0.60/min
    call({ startedAt: 0, endedAt: 60_000, model: "gpt-oss-20b", kind: "llm", transport: "cloudflare-workers-ai", costUsd: 0.6, inToks: 1000, outToks: 1000 }),
    // local twin: 120s (10 min slower... use 120s for the math): opportunity = 0.6 * (120-60)/60 = $0.60
    call({ startedAt: 0, endedAt: 120_000, model: "gpt-oss-20b", kind: "llm", inToks: 1000, outToks: 1000 }),
  ]);
  const c = compareCosts(m)[0];
  assert.equal(c.model, "gpt-oss-20b");
  assert.equal(c.cloud.costUsd, 0.6);
  assert.ok(Math.abs(c.cloud.rateUsdPerMin - 0.6) < 1e-9);
  assert.ok(Math.abs(c.local.opportunityUsd - 0.6) < 1e-9); // 60s slower x $0.60/min = $0.60 (time-valued, NOT realized)
  assert.ok(c.realizedSavingsUsd > 0 && c.realizedSavingsUsd < 0.6); // realized savings exclude opportunity
  assert.equal(c.verdict, "local"); // realized: cloud $0.60 bill − tiny electricity > 0
});

test("compareCosts: local faster is credited", () => {
  const m = mk([
    call({ startedAt: 0, endedAt: 60_000, model: "gpt-oss-20b", kind: "llm", transport: "cloudflare-workers-ai", costUsd: 0.6 }),
    call({ startedAt: 0, endedAt: 30_000, model: "gpt-oss-20b", kind: "llm" }),
  ]);
  const c = compareCosts(m)[0];
  assert.ok(c.local.opportunityUsd < 0); // 30s faster → negative (credit)
  assert.ok(c.realizedSavingsUsd > 0 && c.realizedSavingsUsd < 0.6); // realized savings exclude opportunity
  assert.equal(c.verdict, "local");
});
