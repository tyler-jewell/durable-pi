// Cost validation. Plain Node: the ledger's SQL store runs on node:sqlite, and every DeepSeek number is checked
// against pi-ai's own pricing (calculateCost) and against the tariff file, so they cannot drift apart silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import * as M from "../src/cost/meter.js";
import { PRICES } from "../src/cost/prices.js";
import { meterStorage } from "../src/cost/metered-storage.js";
import { CostStore, type SqlLike } from "../src/cost/store.js";
import { deepseekBase, deepseekModelAt, isPeak, TARIFF } from "../src/tariff.js";
import deepseekTariffExtension from "../pi/extensions/deepseek-tariff.ts";

const at = (iso: string) => Date.parse(iso);
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const PEAK_MONDAY = "2026-11-16T02:00:00Z";
const OFFPEAK_MONDAY = "2026-11-16T05:00:00Z";

/** node:sqlite behind the minimal interface the Durable Object's SQL storage exposes. */
function sqlite(): SqlLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}

/** A pi usage record priced exactly as pi prices it: the tariff model that answered, through calculateCost. */
function piUsage(at: number, tokens: { input: number; cacheRead: number; output: number }): Usage {
  const model = deepseekModelAt("deepseek-flash", at);
  const usage: Usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: 0,
    totalTokens: tokens.input + tokens.cacheRead + tokens.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

// ---- the tariff: one file, one schedule rule ----------------------------------------------------------------

test("peak window: 01–04 and 06–10 UTC, Monday to Friday only", () => {
  assert.equal(isPeak(at("2026-11-16T01:00:00Z")), true, "Mon 01:00 starts peak");
  assert.equal(isPeak(at("2026-11-16T03:59:59Z")), true);
  assert.equal(isPeak(at("2026-11-16T04:00:00Z")), false, "04:00 is off-peak");
  assert.equal(isPeak(at("2026-11-16T00:59:59Z")), false);
  assert.equal(isPeak(at("2026-11-16T06:00:00Z")), true);
  assert.equal(isPeak(at("2026-11-16T09:59:59Z")), true);
  assert.equal(isPeak(at("2026-11-16T10:00:00Z")), false);
  assert.equal(isPeak(at("2026-11-14T02:00:00Z")), false, "Saturday is off-peak");
  assert.equal(isPeak(at("2026-11-15T07:00:00Z")), false, "Sunday is off-peak");
  assert.equal(isPeak(at("2026-11-20T07:00:00Z")), true, "Friday is peak");
});

test("the peak tariff matches pi-ai's built-in DeepSeek catalog (pi prices every request at peak)", () => {
  const catalog = new Map(deepseekProvider().getModels().map((m) => [m.id, m.cost]));
  for (const [id, tariff] of Object.entries(TARIFF.models)) {
    const cost = catalog.get(id);
    assert.ok(cost, `pi-ai has ${id}`);
    close(cost.input, tariff.peak.input);
    close(cost.output, tariff.peak.output);
    close(cost.cacheRead, tariff.peak.cacheRead);
  }
});

test("off-peak is exactly half of peak for every DeepSeek rate, as the source states", () => {
  for (const tariff of Object.values(TARIFF.models))
    for (const k of ["input", "output", "cacheRead"] as const) close(tariff.offPeak[k] * 2, tariff.peak[k]);
});

test("the Cloudflare price book has the rates the cost lines use", () => {
  close(M.msToGbSeconds(1000), 0.125, 1e-12);
  close(PRICES.durableObjects.gbSecondsPerMillion, 12.5);
  close(M.storageLine(1024 ** 3, 30 * 24 * 60).usd, PRICES.durableObjects.storageGbMonth);
});

// ---- pi's metric is the approved LLM cost --------------------------------------------------------------------

test("pi's calculateCost for a tariff model equals the hand computation from the tariff file", () => {
  const usage = piUsage(at(PEAK_MONDAY), { input: 12_345, cacheRead: 67_890, output: 4_321 });
  const t = TARIFF.models["deepseek-flash"].peak;
  close(usage.cost.total, (12_345 * t.input + 67_890 * t.cacheRead + 4_321 * t.output) / 1e6, 1e-12);
  const off = piUsage(at(OFFPEAK_MONDAY), { input: 12_345, cacheRead: 67_890, output: 4_321 });
  close(off.cost.total * 2, usage.cost.total, 1e-12);
});

test("deepseekModelAt gives the tariff in force at that instant, and keeps the rest of pi's model metadata", () => {
  assert.equal(deepseekModelAt("deepseek-flash", at(PEAK_MONDAY)).cost.output, TARIFF.models["deepseek-flash"].peak.output);
  assert.equal(deepseekModelAt("deepseek-flash", at(OFFPEAK_MONDAY)).cost.output, TARIFF.models["deepseek-flash"].offPeak.output);
  const base = deepseekBase("deepseek-flash");
  const picked = deepseekModelAt("deepseek-flash", at(PEAK_MONDAY));
  assert.equal(picked.contextWindow, base.contextWindow);
  assert.equal(picked.api, base.api);
  assert.throws(() => deepseekModelAt("not-a-model", at(PEAK_MONDAY)));
});

test("the ledger's LLM lines are pi's usage.cost, component by component", () => {
  const usage = piUsage(at(OFFPEAK_MONDAY), { input: 900, cacheRead: 300, output: 120 });
  const lines = M.llmLines("deepseek-flash", usage);
  close(lines.reduce((s, l) => s + l.usd, 0), usage.cost.total, 1e-15);
  assert.deepEqual(lines.map((l) => l.sku), [
    "llm.deepseek-flash.input_miss",
    "llm.deepseek-flash.input_hit",
    "llm.deepseek-flash.cache_write",
    "llm.deepseek-flash.output",
  ]);
  assert.ok(lines.every((l) => l.precision === "exact" && l.model === "deepseek-flash"));
});

test("the ledger's lifetime total equals the sum of pi's usage.cost over every turn", () => {
  const store = new CostStore(sqlite());
  let expected = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const t = at(PEAK_MONDAY) + i * 60 * 60_000; // hourly, so both tariffs appear
    const usage = piUsage(t, { input: Math.floor(rand() * 5000), cacheRead: Math.floor(rand() * 5000), output: Math.floor(rand() * 2000) });
    const lines = [...M.llmLines("deepseek-flash", usage), M.doRequestLine(1), M.gbSecondsLine(rand(), "measured"), ...M.sqlRowLines(3, 1)];
    expected += usage.cost.total;
    for (const l of lines) if (l.service !== "llm") expected += l.usd;
    store.record(lines, t);
  }
  const snap = store.snapshot(at(PEAK_MONDAY) + 201 * 60 * 60_000);
  close(snap.totalUsd, expected, 1e-9);
  close(Object.values(snap.byService).reduce((a, b) => a + (b ?? 0), 0), snap.totalUsd, 1e-9);
  assert.ok(snap.byModel["deepseek-flash"].outputTokens > 0);
});

// ---- the host extension: the virtual model routes to the tariff in force at request time ----------------------

test("the host extension registers both tariffs and a virtual model that routes by the clock", () => {
  const providers = new Map<string, { cost: unknown }[]>();
  const virtual = new Map<string, { route: (req: unknown, ctx: unknown) => { model: { provider: string; cost: { output: number } } } }>();
  const fakePi = {
    registerProvider: (name: string, cfg: { models: { id: string; cost: unknown }[] }) => providers.set(name, cfg.models),
    registerVirtualModel: (def: { provider: string; id: string; route: never }) => virtual.set(`${def.provider}/${def.id}`, def),
  };
  deepseekTariffExtension(fakePi as never);

  assert.deepEqual([...providers.keys()].sort(), ["deepseek-offpeak", "deepseek-peak"]);
  assert.ok(virtual.has("deepseek-tariff/deepseek-flash"));

  const realNow = Date.now;
  const registry = {
    find: (provider: string, id: string) => ({ provider, id, cost: providers.get(provider)!.find((m) => m.id === id)!.cost }),
  };
  const route = virtual.get("deepseek-tariff/deepseek-flash")!.route;
  try {
    Date.now = () => at(PEAK_MONDAY);
    const peak = route({ thinkingLevel: "off", reason: "user" }, { modelRegistry: registry });
    assert.equal(peak.model.provider, "deepseek-peak");
    assert.equal(peak.model.cost.output, TARIFF.models["deepseek-flash"].peak.output);

    Date.now = () => at(OFFPEAK_MONDAY);
    const off = route({ thinkingLevel: "off", reason: "continuation" }, { modelRegistry: registry });
    assert.equal(off.model.provider, "deepseek-offpeak", "continuations are priced at the tariff in force, not sticky");
    assert.equal(off.model.cost.output, TARIFF.models["deepseek-flash"].offPeak.output);
  } finally {
    Date.now = realNow;
  }
});

// ---- the metering arithmetic (non-LLM services) ------------------------------------------------------------

test("active duration counts overlapping requests once and drains without double counting", () => {
  const t = new M.ActiveTimer();
  t.enter(0);
  t.enter(100);
  t.exit(200);
  assert.equal(t.active, true);
  t.exit(500);
  assert.equal(t.active, false);
  assert.equal(t.drain(1_000), 500);

  const open = new M.ActiveTimer();
  open.enter(0);
  assert.equal(open.drain(300), 300);
  assert.equal(open.drain(450), 150);
  open.exit(500);
  assert.equal(open.drain(600), 50);
});

test("a Dynamic Worker is billed once per unique code per UTC day", () => {
  const store = new CostStore(sqlite());
  assert.equal(store.markDynamicWorker("2026-11-16", "abc"), true);
  assert.equal(store.markDynamicWorker("2026-11-16", "abc"), false);
  assert.equal(store.markDynamicWorker("2026-11-16", "def"), true);
  assert.equal(store.markDynamicWorker("2026-11-17", "abc"), true);
});

test("the stream series is 60 zero-filled minutes; usdPerHour uses the last five", () => {
  const store = new CostStore(sqlite());
  const now = at("2026-11-16T05:20:30Z");
  store.record([M.doRequestLine(1)], now - 2 * 60_000);
  const snap = store.snapshot(now);
  assert.equal(snap.series.length, 60);
  assert.equal(snap.series.at(-1)!.minute, Math.floor(now / 60_000));
  const nonzero = snap.series.filter((p) => p.usd > 0);
  assert.equal(nonzero.length, 1);
  close(snap.usdPerHour, (nonzero[0].usd / 5) * 60, 1e-12);
});

test("pruning drops minute detail older than 48 hours and keeps lifetime totals", () => {
  const sql = sqlite();
  const store = new CostStore(sql);
  const old = at("2026-11-10T00:00:00Z");
  store.record([M.doRequestLine(5)], old);
  store.prune(old + 49 * 3600_000);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cost_minute").get()!.n, 0);
  assert.equal(store.snapshot(old + 49 * 3600_000).lines.find((l) => l.sku === "durable_objects.requests")!.quantity, 5);
});

test("metered storage counts rows read and written for every consumption path", () => {
  const reports: Array<[number, number]> = [];
  const cursor = (read: number, written: number, rows: unknown[]) => ({
    rowsRead: read,
    rowsWritten: written,
    toArray: () => rows,
    one: () => rows[0],
    *[Symbol.iterator]() {
      yield* rows;
    },
  });
  const fake = {
    sql: { exec: () => cursor(3, 1, [{ a: 1 }, { a: 2 }, { a: 3 }]), databaseSize: 4096 },
    transactionSync: (fn: () => unknown) => fn(),
  };
  const wrapped = meterStorage(fake, (r, w) => reports.push([r, w]));
  assert.equal(wrapped.sql.databaseSize, 4096);
  assert.equal(wrapped.transactionSync(() => 42), 42);
  wrapped.sql.exec("SELECT 1").toArray();
  for (const _row of wrapped.sql.exec("SELECT 1")) void _row;
  wrapped.sql.exec("SELECT 1").one();
  assert.deepEqual(reports, [[3, 1], [3, 1], [3, 1]]);
});

test("Dynamic Worker and secret lines carry the right service, unit and precision", () => {
  const dw = M.dynamicWorkerLines(1, 1, 250);
  assert.deepEqual(dw.map((l) => l.sku), ["dynamic_workers.created", "dynamic_workers.requests", "dynamic_workers.cpu_ms"]);
  assert.equal(dw[2].precision, "estimated");
  close(dw[0].usd, PRICES.dynamicWorkers.createdPerWorkerPerDay);
  assert.equal(M.secretsLine(2).usd, 0);
  assert.equal(M.secretsLine(2).quantity, 2);
});
