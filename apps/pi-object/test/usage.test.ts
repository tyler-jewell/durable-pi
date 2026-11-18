// Telemetry: pi's counts are copied exactly, the app's own clock is measured, and nothing here carries a price.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as T from "../src/cost/meter.js";
import { meterStorage } from "../src/cost/metered-storage.js";
import { UsageStore, type SqlLike } from "../src/cost/store.js";

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

/** The shape pi-ai reports on an assistant message (only the fields we read). */
const piUsage = {
  input: 4364,
  output: 1055,
  cacheRead: 768,
  cacheWrite: 0,
  reasoning: 830,
  totalTokens: 6187,
  cost: { input: 0.00288, output: 0.00209, cacheRead: 0.000017, cacheWrite: 0, total: 0.002987, totalFromProvider: false },
} as never;

test("pi's token counts are copied exactly, with no price on any line", () => {
  const lines = T.llmLines("deepseek-flash", piUsage);
  const get = (kind: string) => lines.find((l) => l.sku === `llm.deepseek-flash.${kind}`)!;
  assert.equal(get("input_miss").quantity, 4364);
  assert.equal(get("input_hit").quantity, 768);
  assert.equal(get("output").quantity, 1055);
  assert.equal(get("output_reasoning").quantity, 830);
  assert.equal(get("estimate").unit, "usd");
  assert.equal(get("estimate").quantity, 0.002987);
  for (const line of lines) {
    assert.equal(line.source, "pi");
    assert.equal("usd" in line, false, `${line.sku} must not carry a price`);
  }
});

test("reasoning is part of output, so the store adds it once", () => {
  const sql = sqlite();
  const store = new UsageStore(sql);
  store.record(T.llmLines("deepseek-flash", piUsage));
  const { byModel } = store.snapshot();
  assert.equal(byModel["deepseek-flash"].output, 1055);
  assert.equal(byModel["deepseek-flash"].outputReasoning, 830);
  assert.equal(byModel["deepseek-flash"].inputMiss, 4364);
  assert.equal(byModel["deepseek-flash"].inputHit, 768);
});

test("tool calls and their wall-clock time are counted per tool", () => {
  const lines = T.toolLines("exec", 250);
  assert.deepEqual(lines.map((l) => [l.sku, l.quantity]), [["tools.exec.calls", 1], ["tools.exec.wall_ms", 250]]);
  assert.ok(lines.every((l) => l.source === "measured"));
});

test("LLM wall time is measured per model call", () => {
  const line = T.llmWallLine("deepseek-flash", 1234);
  assert.equal(line.sku, "llm.deepseek-flash.wall_ms");
  assert.equal(line.quantity, 1234);
  assert.equal(line.source, "measured");
});

test("active duration counts overlapping requests once and drains without double counting", () => {
  const t = new T.ActiveTimer();
  t.enter(1000);
  t.enter(1200); // overlaps the first request
  t.exit(1500);
  assert.equal(t.drain(1600), 600); // still one request open since 1000: 1000 → 1600
  t.exit(2000);
  assert.equal(t.drain(2000), 400); // drain moved the start to 1600, so 1600 → 2000 is the only new time
  assert.equal(t.drain(2100), 0);
});

test("a Dynamic Worker is counted once per unique code per UTC day", () => {
  const store = new UsageStore(sqlite());
  assert.equal(store.markDynamicWorker("2026-11-18", "abc"), true);
  assert.equal(store.markDynamicWorker("2026-11-18", "abc"), false);
  assert.equal(store.markDynamicWorker("2026-11-18", "def"), true);
  assert.equal(store.markDynamicWorker("2026-11-19", "abc"), true);
});

test("lifetime totals accumulate, zero lines are skipped, live lines are not stored", () => {
  const sql = sqlite();
  const store = new UsageStore(sql);
  store.record([T.toolLines("exec", 100)[1], T.doRequestLine(1)]);
  store.record([T.toolLines("exec", 50)[1], T.doRequestLine(0)]);
  const { rows } = store.snapshot([T.secretsLine(2)]);
  const bySku = Object.fromEntries(rows.map((r) => [r.sku, r.quantity]));
  assert.equal(bySku["tools.exec.wall_ms"], 150);
  assert.equal(bySku["durable_objects.requests"], 1);
  assert.equal(bySku["secrets.count"], 2);
  // The live secret line is only in the snapshot.
  const stored = new UsageStore(sql).snapshot().rows.map((r) => r.sku);
  assert.equal(stored.includes("secrets.count"), false);
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

test("the cost code has no tariff or rate table left in it", () => {
  // The runtime cost code only. Validation tooling (scripts/, test/) reads the rate reference on purpose.
  const roots = [join(process.cwd(), "src")];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith("usage.test.ts")) files.push(p);
    }
  };
  roots.forEach(walk);
  const hits = files.filter((f) => /tariff|peak|offPeak|PRICES\./i.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "tariff or price references found");
});
