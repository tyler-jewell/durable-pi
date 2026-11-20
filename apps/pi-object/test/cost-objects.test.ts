// Cost objects: DeepSeek spend from the balance and the configured top-ups, the free-tier toggle, the rate
// window, and the balance reader. Pure functions, so these run under plain Node with no Cloudflare runtime.

import { test } from "vitest";
import assert from "node:assert/strict";

import { deepseekView, type DeepseekBalance } from "../src/cost/objects.js";
import { readDeepseekBalance } from "../src/cost/deepseek.js";
import { UsageStore, type SqlLike } from "../src/cost/store.js";
import { DatabaseSync } from "node:sqlite";

const at = Date.UTC(2026, 10, 18, 18, 0, 0);
const bal = (total: number, toppedUp: number, granted = 0, when = at): DeepseekBalance => ({ at: when, total, granted, toppedUp });
const base = { id: "deepseek", label: "DeepSeek", freeTier: false };
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("list cost is top-ups minus balance; actual cost is top-ups minus topped-up balance", () => {
  // Real figures from this account: $20 topped up, $19.54 left, nothing granted.
  const v = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: bal(19.54, 19.54), prior: null, freeTier: false });
  close(v.listUsd, 0.46);
  close(v.actualUsd, 0.46);
  close(v.usd, 0.46);
  assert.equal(v.status, "ok");
  assert.equal(v.precisionUsd, 0.005);
});

test("free-tier OFF shows the list cost; ON shows the actual cost, labelled as assumed", () => {
  // $20 top-up, $5 granted, $3 of usage taken from the granted credit: balance 22 = 2 granted + 20 topped up.
  const config = { topUpUsd: 20, grantedUsd: 5 };
  const off = deepseekView({ ...base, config, balance: bal(22, 20, 2), prior: null, freeTier: false });
  const on = deepseekView({ ...base, config, balance: bal(22, 20, 2), prior: null, freeTier: true });
  close(off.listUsd, 3);
  close(off.actualUsd, 0);
  close(off.usd, 3);
  close(on.usd, 0);
  assert.match(off.basis, /list cost/);
  assert.match(on.basis, /free-tier assumed/);
});

test("without a configured top-up no dollars are shown", () => {
  const v = deepseekView({ ...base, config: { topUpUsd: null, grantedUsd: 0 }, balance: bal(19.54, 19.54), prior: null, freeTier: false });
  assert.equal(v.status, "unconfigured");
  assert.equal(v.usd, null);
  assert.match(v.note ?? "", /topUpUsd/);
});

test("without any balance reading the object is unavailable, not zero", () => {
  const v = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: null, prior: null, freeTier: false, note: "HTTP 500" });
  assert.equal(v.status, "unavailable");
  assert.equal(v.usd, null);
  assert.equal(v.note, "HTTP 500");
});

test("a balance above what the configured top-ups allow is flagged as a config mismatch", () => {
  // A top-up was made but not recorded: the balance exceeds topUp + granted.
  const v = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: bal(25, 25), prior: null, freeTier: false });
  assert.equal(v.status, "config-mismatch");
  assert.ok((v.listUsd ?? 0) < 0);
});

test("a failed refresh keeps the last reading and marks it stale", () => {
  const v = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: bal(19.54, 19.54, 0, at - 600_000), prior: null, freeTier: false, note: "balance refresh failed: timeout" });
  assert.equal(v.status, "stale");
  close(v.usd, 0.46);
  assert.match(v.note ?? "", /timeout/);
});

test("burn rate is consumption over the rate window, per hour, on the same basis as usd", () => {
  // Ten minutes: 19.60 → 19.54 is $0.06 in 1/6 h = $0.36/h.
  const prior = bal(19.6, 19.6, 0, at - 600_000);
  const now = bal(19.54, 19.54, 0, at);
  const list = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: now, prior, freeTier: false });
  close(list.burnUsdPerHour, 0.36);
  const actual = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: now, prior, freeTier: true });
  close(actual.burnUsdPerHour, 0.36);
});

test("burn rate is null without an older sample to compare against", () => {
  const v = deepseekView({ ...base, config: { topUpUsd: 20, grantedUsd: 0 }, balance: bal(19.54, 19.54), prior: null, freeTier: false });
  assert.equal(v.burnUsdPerHour, null);
});

test("the balance reader takes the USD entry and fails on anything it cannot trust", async () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  const ok = await readDeepseekBalance("k", reply({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "19.54", granted_balance: "0.00", topped_up_balance: "19.54" }],
  }), 42);
  assert.deepEqual(ok, { at: 42, total: 19.54, granted: 0, toppedUp: 19.54 });

  await assert.rejects(readDeepseekBalance("k", reply({ balance_infos: [{ currency: "CNY", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }] })), /no USD entry/);
  await assert.rejects(readDeepseekBalance("k", reply({}, 401)), /HTTP 401/);
  await assert.rejects(readDeepseekBalance("k", reply({ balance_infos: [{ currency: "USD", total_balance: "x", granted_balance: "0", topped_up_balance: "0" }] })), /not a number/);
});

test("balance samples: the rate window uses the newest sample at or before the cutoff", () => {
  const db = new DatabaseSync(":memory:");
  const sql: SqlLike = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? (stmt.all(...(bindings as never[])) as Record<string, unknown>[]) : (stmt.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  };
  const store = new UsageStore(sql);
  store.recordBalance(bal(19.9, 19.9, 0, at - 900_000));
  store.recordBalance(bal(19.8, 19.8, 0, at - 400_000));
  store.recordBalance(bal(19.54, 19.54, 0, at));
  assert.equal(store.latestBalance()?.total, 19.54);
  assert.equal(store.balanceAtOrBefore(at - 300_000)?.total, 19.8);
  assert.equal(store.balanceAtOrBefore(at - 1_000_000), null);
});
