// Cost ledger validation. Runs in plain Node: the SQL store is backed by node:sqlite, and the price book is
// cross-checked against pi-ai's own DeepSeek catalog, so the two cannot drift apart silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import * as M from "../src/cost/meter.js";
import { isDeepSeekPeak, PRICES } from "../src/cost/prices.js";
import { meterStorage } from "../src/cost/metered-storage.js";
import { CostStore, type SqlLike } from "../src/cost/store.js";

/** node:sqlite behind the same minimal interface the Durable Object's SQL storage exposes. */
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

const at = (iso: string) => Date.parse(iso);
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("DeepSeek peak window: 01–04 and 06–10 UTC, Monday to Friday only", () => {
  assert.equal(isDeepSeekPeak(at("2026-11-16T01:00:00Z")), true, "Mon 01:00 starts peak");
  assert.equal(isDeepSeekPeak(at("2026-11-16T03:59:59Z")), true);
  assert.equal(isDeepSeekPeak(at("2026-11-16T04:00:00Z")), false, "04:00 is off-peak");
  assert.equal(isDeepSeekPeak(at("2026-11-16T00:59:59Z")), false);
  assert.equal(isDeepSeekPeak(at("2026-11-16T06:00:00Z")), true);
  assert.equal(isDeepSeekPeak(at("2026-11-16T09:59:59Z")), true);
  assert.equal(isDeepSeekPeak(at("2026-11-16T10:00:00Z")), false);
  assert.equal(isDeepSeekPeak(at("2026-11-14T02:00:00Z")), false, "Saturday is off-peak");
  assert.equal(isDeepSeekPeak(at("2026-11-15T07:00:00Z")), false, "Sunday is off-peak");
  assert.equal(isDeepSeekPeak(at("2026-11-20T07:00:00Z")), true, "Friday peak");
});

test("the price book matches pi-ai's DeepSeek catalog at peak (pi-ai prices every request at peak)", () => {
  const catalog = new Map(deepseekProvider().getModels().map((m) => [m.id, m.cost]));
  for (const [id, rates] of Object.entries(PRICES.deepseek)) {
    const cost = catalog.get(id);
    assert.ok(cost, `pi-ai has ${id}`);
    close(cost.input, rates.inputMiss.peak);
    close(cost.cacheRead, rates.inputHit.peak);
    close(cost.output, rates.output.peak);
  }
});

test("LLM cost at peak equals pi-ai's own reported cost for the same tokens", () => {
  const model = deepseekProvider().getModels().find((m) => m.id === "deepseek-flash")!;
  const usage = { input: 12_345, cacheRead: 67_890, output: 4_321 };
  const ours = M.deepseekLines("deepseek-flash", usage, at("2026-11-16T02:00:00Z"))
    .reduce((sum, l) => sum + l.usd, 0);
  const piAi =
    (usage.input * model.cost.input + usage.cacheRead * model.cost.cacheRead + usage.output * model.cost.output) / 1e6;
  close(ours, piAi, 1e-12);
});

test("off-peak is half of peak for every DeepSeek rate", () => {
  for (const rates of Object.values(PRICES.deepseek))
    for (const r of [rates.inputMiss, rates.inputHit, rates.output]) close(r.offPeak * 2, r.peak);
  const usage = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  const peak = M.deepseekLines("deepseek-flash", usage, at("2026-11-16T02:00:00Z")).reduce((s, l) => s + l.usd, 0);
  const off = M.deepseekLines("deepseek-flash", usage, at("2026-11-16T05:00:00Z")).reduce((s, l) => s + l.usd, 0);
  close(off * 2, peak);
});

test("active duration counts overlapping requests once and converts to GB-seconds", () => {
  const t = new M.ActiveTimer();
  t.enter(0);
  t.enter(100); // overlaps the first request: must not add time twice
  t.exit(200);
  assert.equal(t.active, true);
  t.exit(500);
  assert.equal(t.active, false);
  assert.equal(t.drain(1_000), 500);
  assert.equal(M.msToGbSeconds(1_000), 0.125, "one second at 128 MB is 0.125 GB-s");
});

test("drain includes an open request up to now and does not double count it later", () => {
  const t = new M.ActiveTimer();
  t.enter(0);
  assert.equal(t.drain(300), 300);
  assert.equal(t.drain(450), 150);
  t.exit(500);
  assert.equal(t.drain(600), 50);
});

test("storage is billed per GB-month, pro-rated by minutes held", () => {
  const oneGbForAMonth = M.storageLine(1024 ** 3, 30 * 24 * 60);
  close(oneGbForAMonth.usd, PRICES.durableObjects.storageGbMonth);
});

test("the ledger's lifetime totals equal the sum of every recorded line", () => {
  const store = new CostStore(sqlite());
  let expected = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const lines = [
      ...M.deepseekLines("deepseek-flash", { input: Math.floor(rand() * 5000), cacheRead: Math.floor(rand() * 5000), output: Math.floor(rand() * 2000) }, at("2026-11-16T02:00:00Z") + i * 60_000),
      M.doRequestLine(1),
      M.gbSecondsLine(rand(), "measured"),
      ...M.sqlRowLines(Math.floor(rand() * 50), Math.floor(rand() * 5)),
    ];
    for (const l of lines) expected += l.usd;
    store.record(lines, at("2026-11-16T02:00:00Z") + i * 60_000);
  }
  const snap = store.snapshot(at("2026-11-16T05:20:00Z"));
  close(snap.totalUsd, expected, 1e-9);
  close(Object.values(snap.byService).reduce((a, b) => a + (b ?? 0), 0), snap.totalUsd, 1e-9);
  assert.ok(snap.byModel["deepseek.deepseek-flash"].outputTokens > 0);
});

test("the stream series is 60 minutes, zero-filled, and usdPerHour reflects the last five minutes", () => {
  const store = new CostStore(sqlite());
  const now = at("2026-11-16T05:20:30Z");
  store.record([M.doRequestLine(1)], now - 2 * 60_000); // two minutes ago: 1 request
  const snap = store.snapshot(now);
  assert.equal(snap.series.length, 60);
  assert.equal(snap.series[snap.series.length - 1].minute, Math.floor(now / 60_000));
  const nonzero = snap.series.filter((p) => p.usd > 0);
  assert.equal(nonzero.length, 1);
  close(snap.usdPerHour, (nonzero[0].usd / 5) * 60, 1e-12);
});

test("a Dynamic Worker counts once per unique code per UTC day", () => {
  const store = new CostStore(sqlite());
  assert.equal(store.markDynamicWorker("2026-11-16", "abc"), true);
  assert.equal(store.markDynamicWorker("2026-11-16", "abc"), false, "same code, same day: not billed again");
  assert.equal(store.markDynamicWorker("2026-11-16", "def"), true, "different code is a new Dynamic Worker");
  assert.equal(store.markDynamicWorker("2026-11-17", "abc"), true, "new day, new count");
});

test("pruning drops minute detail older than 48 hours but keeps lifetime totals", () => {
  const sql = sqlite();
  const store = new CostStore(sql);
  const old = at("2026-11-10T00:00:00Z");
  store.record([M.doRequestLine(5)], old);
  store.prune(old + 49 * 3600_000);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cost_minute").get()!.n, 0);
  assert.equal(store.snapshot(old + 49 * 3600_000).lines.find((l) => l.sku === "durable_objects.requests")!.quantity, 5);
});

test("metered storage counts rows read and written for every consumption path", async () => {
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
    sql: {
      exec: (_q: string) => cursor(3, 1, [{ a: 1 }, { a: 2 }, { a: 3 }]),
      databaseSize: 4096,
    },
    transactionSync: (fn: () => unknown) => fn(),
  };
  const wrapped = meterStorage(fake, (r, w) => reports.push([r, w]));
  assert.equal(wrapped.sql.databaseSize, 4096, "non-exec properties pass through");
  assert.equal(wrapped.transactionSync(() => 42), 42, "methods are bound to the real storage");
  wrapped.sql.exec("SELECT 1").toArray();
  assert.deepEqual(reports, [[3, 1]]);
  for (const _row of wrapped.sql.exec("SELECT 1")) void _row;
  assert.deepEqual(reports, [[3, 1], [3, 1]]);
  wrapped.sql.exec("SELECT 1").one();
  assert.equal(reports.length, 3);
});

test("the Dynamic Worker, tool and secret lines carry the right service, unit and precision", () => {
  const dw = M.dynamicWorkerLines(1, 1, 250);
  assert.deepEqual(dw.map((l) => l.sku), ["dynamic_workers.created", "dynamic_workers.requests", "dynamic_workers.cpu_ms"]);
  assert.equal(dw[2].precision, "estimated", "wall-clock is an upper bound, not a measurement");
  close(dw[0].usd, PRICES.dynamicWorkers.createdPerWorkerPerDay);
  assert.equal(M.secretsLine(2).usd, 0, "secrets are listed, not billed");
  assert.equal(M.secretsLine(2).quantity, 2);
});
