// The Cloudflare cost object. The rate card here is SYNTHETIC: its prices are arbitrary round numbers chosen to
// make the arithmetic easy to check. They are not Cloudflare's prices, and nothing in the app reads them from here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DO_COMPONENT, fetchRateCard, parseRateCard, ROUNDING_USD_PER_UNIT, type RawPlan } from "../src/cost/cloudflare-rate-card.js";
import { cloudflareDoView, doQuantities, DO_MEMORY_GB, type DoQuantities } from "../src/cost/cloudflare-do.js";
import { periodFor, UsageStore, type SqlLike } from "../src/cost/store.js";
import * as T from "../src/cost/meter.js";

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

const usage = (over: Partial<DoQuantities> = {}): DoQuantities => ({
  requests: 0, duration: 0, rowsRead: 0, rowsWritten: 0, storedData: 0, dynamicWorkers: 0, ...over,
});

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
  const v = cloudflareDoView({ card: card(), quantities: q, freeTier: false, asOf: 0 });
  const req = v.lines.find((l) => l.component === "requests")!;
  close(req.listUsd, 1.5);
  close(req.actualUsd, 0.5);
  close(v.usd, 1.5, 1e-9); // free tier off shows list
  const on = cloudflareDoView({ card: card(), quantities: q, freeTier: true, asOf: 0 });
  close(on.usd, 0.5, 1e-9); // free tier on shows actual
});

test("duration is priced in GB-s after the 128 MB memory conversion", () => {
  // 1,000,000 ms of active time is 1,000 s, which is 1,000 × 0.128 = 128 GB-s, inside the 400,000 allowance.
  const q = doQuantities({ "durable_objects.duration": 1_000_000 });
  close(q.duration, 1000 * DO_MEMORY_GB, 1e-9);
  close(q.duration, 128, 1e-9);
  const v = cloudflareDoView({ card: card(), quantities: usage({ duration: q.duration }), freeTier: true, asOf: 0 });
  close(v.lines.find((l) => l.component === "duration")!.actualUsd, 0);
});

test("stored data is GB-months from byte-minutes (decimal GB, 30-day month)", () => {
  const oneGbForAMonth = 1e9 * 30 * 24 * 60;
  close(doQuantities({ "storage.sqlite": oneGbForAMonth }).storedData, 1, 1e-12);
});

test("each line carries the rounding band: the most the six-decimal card can be off", () => {
  const off = cloudflareDoView({ card: card(), quantities: usage({ requests: 1_500_000 }), freeTier: false, asOf: 0 });
  close(off.bandUsd, 1_500_000 * ROUNDING_USD_PER_UNIT, 1e-12);
  const on = cloudflareDoView({ card: card(), quantities: usage({ requests: 1_500_000 }), freeTier: true, asOf: 0 });
  close(on.bandUsd, 500_000 * ROUNDING_USD_PER_UNIT, 1e-12);
});

test("with no rate card the object is unavailable and shows no dollars", () => {
  const v = cloudflareDoView({ card: null, quantities: usage(), freeTier: false, asOf: 0, note: "fetch failed" });
  assert.equal(v.status, "unavailable");
  assert.equal(v.usd, null);
  assert.equal(v.note, "fetch failed");
});

test("a card that cannot be refreshed is kept, and the object says it is stale", () => {
  const v = cloudflareDoView({ card: card(), quantities: usage({ requests: 1_500_000 }), freeTier: false, asOf: 0, note: "refresh failed: timeout" });
  assert.equal(v.status, "stale");
  close(v.usd, 1.5, 1e-9);
});

test("the rate card is read from the account's subscriptions, skipping plans without Durable Objects", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.endsWith("/accounts/acc-1/subscriptions")) return json({ success: true, result: [{ rate_plan: { id: "images" } }, { rate_plan: { id: "synthetic" } }] });
    if (u.endsWith("/billing/rate_plans/images")) return json({ success: true, result: { id: "images", currency: "USD", components: [comp("images_storage", 1)] } });
    if (u.endsWith("/billing/rate_plans/synthetic")) return json({ success: true, result: synthetic() });
    return json({ success: false, errors: [{ message: "unexpected" }] }, 404);
  }) as typeof fetch;

  const c = await fetchRateCard("acc-1", "tok", fake);
  assert.equal(c.planId, "synthetic");
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

// --- telemetry periods: allowances reset per month, and Dynamic Workers per day ---

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

test("usage is totalled per UTC month, so each month gets its own allowance", () => {
  const store = new UsageStore(sqlite());
  const nov = Date.UTC(2026, 10, 15);
  const dec = Date.UTC(2026, 11, 2);
  store.record([{ service: "durable_objects", sku: "durable_objects.requests", unit: "requests", quantity: 900_000, source: "measured" }], nov);
  store.record([{ service: "durable_objects", sku: "durable_objects.requests", unit: "requests", quantity: 200_000, source: "measured" }], dec);
  assert.equal(store.periodTotals(periodFor("x", nov))["durable_objects.requests"], 900_000);
  assert.equal(store.periodTotals(periodFor("x", dec))["durable_objects.requests"], 200_000);
  // Lifetime totals still add both months, for the telemetry view.
  assert.equal(store.snapshot().rows.find((r) => r.sku === "durable_objects.requests")!.quantity, 1_100_000);
});

test("Dynamic Workers are totalled per UTC day, not per month", () => {
  const store = new UsageStore(sqlite());
  const d1 = Date.UTC(2026, 10, 18, 10);
  const d2 = Date.UTC(2026, 10, 19, 10);
  store.record(T.dynamicWorkerLines(1, 1, 5), d1);
  store.record(T.dynamicWorkerLines(1, 1, 5), d2);
  assert.equal(store.periodTotals("2026-11-18")["dynamic_workers.created"], 1);
  assert.equal(store.periodTotals("2026-11-19")["dynamic_workers.created"], 1);
});
