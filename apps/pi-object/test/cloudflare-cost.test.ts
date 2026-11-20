// The Cloudflare cost object. The rate card here is SYNTHETIC: its prices are arbitrary round numbers chosen to
// make the arithmetic easy to check. They are not Cloudflare's prices, and nothing in the app reads them from here.

import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DO_COMPONENT, fetchRateCard, parseRateCard, ROUNDING_USD_PER_UNIT, type RawPlan } from "../src/cost/cloudflare-rate-card.js";
import { cloudflareDoView, doPeriodUsage, DO_MEMORY_GB, type DoPeriodUsage } from "../src/cost/cloudflare-do.js";
import { dayOf, UsageStore, type SqlLike } from "../src/cost/store.js";

const close = (a: number | null | undefined, b: number, eps = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= eps, `${a} != ${b}`);

const comp = (name: string, price: number, firstUnit = 1) => ({
  name, chargeModel: "tiered", cfStartOfFirstUnit: firstUnit, tiers: [{ lowerThreshold: 0, upperThreshold: 0, price }],
});
const synthetic = (): RawPlan => ({
  id: "synthetic",
  currency: "USD",
  components: [
    comp(DO_COMPONENT.requests, 0.000001, 1_000_001),
    comp(DO_COMPONENT.duration, 0.00001, 400_001),
    comp(DO_COMPONENT.rowsRead, 0.000002, 25_000_000_001),
    comp(DO_COMPONENT.rowsWritten, 0.000003, 50_000_001),
    comp(DO_COMPONENT.storedData, 0.2, 6),
    comp(DO_COMPONENT.dynamicWorkers, 0.002, 1001),
  ],
});
const card = () => parseRateCard(synthetic());

const usage = (over: Partial<DoPeriodUsage["quantities"]> & { dynamicDaily?: number[] } = {}): DoPeriodUsage => {
  const { dynamicDaily = [], ...q } = over;
  return {
    quantities: { requests: 0, duration: 0, rowsRead: 0, rowsWritten: 0, storedData: 0, dynamicWorkers: 0, ...q },
    dynamicDaily,
  };
};
const period = { start: "2026-10-30T00:00:00Z", end: "2026-11-30T00:00:00Z" };

test("the card's first billable unit becomes the included allowance (one less)", () => {
  const c = card();
  assert.equal(c.components.requests.includedUnits, 1_000_000);
  assert.equal(c.components.duration.includedUnits, 400_000);
  assert.equal(c.components.rowsRead.includedUnits, 25_000_000_000);
  assert.equal(c.components.storedData.includedUnits, 5);
  assert.equal(c.components.dynamicWorkers.includedUnits, 1000);
});

test("a plan without a Durable Objects component is refused, not priced as zero", () => {
  const plan = synthetic();
  plan.components = plan.components.filter((c) => c.name !== DO_COMPONENT.duration);
  assert.throws(() => parseRateCard(plan), /no component worker_durable_objects_duration/);
});

test("a plan in another currency or with a tier layout we do not price is refused", () => {
  assert.throws(() => parseRateCard({ ...synthetic(), currency: "EUR" }), /not USD/);
  const plan = synthetic();
  plan.components[0] = { ...plan.components[0], tiers: [{ lowerThreshold: 0, upperThreshold: 10, price: 1 }, { lowerThreshold: 10, upperThreshold: 0, price: 2 }] };
  assert.throws(() => parseRateCard(plan), /tier layout/);
});

test("list cost prices every unit; actual cost prices only what is above the allowance", () => {
  const q = usage({ requests: 1_500_000 });
  const v = cloudflareDoView({ card: card(), period, usage: q, freeTier: false, asOf: 0 });
  const req = v.lines.find((l) => l.component === "requests")!;
  close(req.listUsd, 1.5);
  close(req.actualUsd, 0.5);
  close(v.usd, 1.5, 1e-9); // free tier off shows list
  const on = cloudflareDoView({ card: card(), period, usage: q, freeTier: true, asOf: 0 });
  close(on.usd, 0.5, 1e-9); // free tier on shows actual
});

test("duration is priced in GB-s after the 128 MB memory conversion", () => {
  // 1,000,000 ms of active time is 1,000 s, which is 1,000 × 0.128 = 128 GB-s, inside the 400,000 allowance.
  const q = doPeriodUsage([{ day: "2026-11-18", sku: "durable_objects.duration", quantity: 1_000_000 }], "2026-10-30", "2026-11-30");
  close(q.quantities.duration, 1000 * DO_MEMORY_GB, 1e-9);
  close(q.quantities.duration, 128, 1e-9);
  const v = cloudflareDoView({ card: card(), period, usage: usage({ duration: q.quantities.duration }), freeTier: true, asOf: 0 });
  close(v.lines.find((l) => l.component === "duration")!.actualUsd, 0);
});

test("stored data is GB-months from byte-minutes (decimal GB, 30-day month)", () => {
  const oneGbForAMonth = 1e9 * 30 * 24 * 60;
  close(doPeriodUsage([{ day: "2026-11-18", sku: "storage.sqlite", quantity: oneGbForAMonth }], "2026-10-30", "2026-11-30").quantities.storedData, 1, 1e-12);
});

test("each line carries the rounding band: the most the six-decimal card can be off", () => {
  const off = cloudflareDoView({ card: card(), period, usage: usage({ requests: 1_500_000 }), freeTier: false, asOf: 0 });
  close(off.bandUsd, 1_500_000 * ROUNDING_USD_PER_UNIT, 1e-12);
  const on = cloudflareDoView({ card: card(), period, usage: usage({ requests: 1_500_000 }), freeTier: true, asOf: 0 });
  close(on.bandUsd, 500_000 * ROUNDING_USD_PER_UNIT, 1e-12);
});

test("with no rate card the object is unavailable and shows no dollars", () => {
  const v = cloudflareDoView({ card: null, period: null, usage: usage(), freeTier: false, asOf: 0, note: "fetch failed" });
  assert.equal(v.status, "unavailable");
  assert.equal(v.usd, null);
  assert.equal(v.note, "fetch failed");
});

test("a card that cannot be refreshed is kept, and the object says it is stale", () => {
  const v = cloudflareDoView({ card: card(), period, usage: usage({ requests: 1_500_000 }), freeTier: false, asOf: 0, note: "refresh failed: timeout" });
  assert.equal(v.status, "stale");
  close(v.usd, 1.5, 1e-9);
});

test("the rate card is read from the account's subscriptions, skipping plans without Durable Objects", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.endsWith("/accounts/acc-1/subscriptions")) return json({ success: true, result: [{ rate_plan: { id: "images" } }, { rate_plan: { id: "synthetic" }, current_period_start: "2026-10-30T00:00:00Z", current_period_end: "2026-11-30T00:00:00Z" }] });
    if (u.endsWith("/billing/rate_plans/images")) return json({ success: true, result: { id: "images", currency: "USD", components: [comp("images_storage", 1)] } });
    if (u.endsWith("/billing/rate_plans/synthetic")) return json({ success: true, result: synthetic() });
    return json({ success: false, errors: [{ message: "unexpected" }] }, 404);
  }) as typeof fetch;

  const { card: c, period: p } = await fetchRateCard("acc-1", "tok", fake);
  assert.equal(c.planId, "synthetic");
  assert.deepEqual(p, { start: "2026-10-30T00:00:00Z", end: "2026-11-30T00:00:00Z" });
  assert.ok(calls.every((x) => x.auth === "Bearer tok"));
  assert.equal(calls.length, 3);
});

test("a subscription listing that is denied surfaces the API's own message", async () => {
  const denied = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 })) as typeof fetch;
  await assert.rejects(fetchRateCard("acc-1", "tok", denied), /HTTP 403: Authentication error/);
});

test("no subscription carries the Durable Objects card: the fetch says so", async () => {
  const none = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/subscriptions")) return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  await assert.rejects(fetchRateCard("acc-1", "tok", none), /no subscription on this account carries/);
});

// --- billing periods: allowances reset on the subscription period; Dynamic Workers per day ---

function sqlite(): SqlLike {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? (stmt.all(...(bindings as never[])) as Record<string, unknown>[]) : (stmt.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  };
}

test("usage is kept per UTC day and summed across the billing period, not the calendar month", () => {
  const store = new UsageStore(sqlite());
  const oct31 = Date.UTC(2026, 9, 31, 12);
  const nov15 = Date.UTC(2026, 10, 15, 12);
  const dec2 = Date.UTC(2026, 11, 2, 12);
  const req = (quantity: number, at: number) =>
    store.record([{ service: "durable_objects", sku: "durable_objects.requests", unit: "requests", quantity, source: "measured" }], at);
  req(100_000, oct31); // before this billing period (starts 30 Oct) is still inside it
  req(900_000, nov15);
  req(200_000, dec2); // after the period ends on 30 Nov is excluded below
  const inside = store.dailyRows("2026-10-30", "2026-11-30");
  assert.equal(doPeriodUsage(inside, "2026-10-30", "2026-11-30").quantities.requests, 1_000_000);
  assert.equal(dayOf(oct31), "2026-10-31");
});

test("Dynamic Workers: the included count applies to each day, not once to the period", () => {
  const rows = [
    { day: "2026-11-18", sku: "dynamic_workers.created", quantity: 1500 },
    { day: "2026-11-19", sku: "dynamic_workers.created", quantity: 1500 },
  ];
  const u = doPeriodUsage(rows, "2026-10-30", "2026-11-30");
  assert.equal(u.quantities.dynamicWorkers, 3000);
  const lines = cloudflareDoView({ card: card(), period, usage: u, freeTier: true, asOf: 0 }).lines;
  // Included is 1000 per day: 500 + 500 billable, at 0.002 per worker (synthetic price).
  close(lines.find((l) => l.component === "dynamicWorkers")!.actualUsd, 1000 * 0.002, 1e-12);
});
