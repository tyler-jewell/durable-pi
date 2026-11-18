// Persists telemetry and provider balance samples in SQLite. Lifetime totals are one row per SKU, so reads stay
// O(SKUs) however long the agent runs. Written against a minimal SQL interface, so the same code runs in a
// Durable Object (ctx.storage.sql) and in Node tests (node:sqlite).

import type { Line, Service, Source } from "./meter.js";

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const RETAIN_MS = 48 * 60 * 60_000;

/** UTC month for most services; UTC day for Dynamic Workers, whose included allowance is per day. */
export const periodFor = (sku: string, atMs: number): string =>
  sku.startsWith("dynamic_workers.") ? new Date(atMs).toISOString().slice(0, 10) : new Date(atMs).toISOString().slice(0, 7);

export interface UsageRow {
  sku: string;
  service: Service;
  unit: string;
  source: Source;
  model?: string;
  quantity: number;
}

/** One reading of the provider balance. Amounts are USD as the provider reports them (cents). */
export interface BalanceSample {
  at: number;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface UsageSnapshot {
  rows: UsageRow[];
  /** Token counts and LLM time per model, summed from the rows above. */
  byModel: Record<string, { inputMiss: number; inputHit: number; output: number; outputReasoning: number; wallMs: number; estimateUsd: number }>;
}

export class UsageStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_totals (
      sku TEXT PRIMARY KEY, service TEXT NOT NULL, unit TEXT NOT NULL, source TEXT NOT NULL,
      model TEXT, quantity REAL NOT NULL DEFAULT 0)`);
    // Totals per billing period: a calendar month (UTC) for most services, a day for Dynamic Workers. Included
    // allowances reset on those boundaries, so the cost object needs the period, not the lifetime total.
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_period (
      period TEXT NOT NULL, sku TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0, PRIMARY KEY (period, sku))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS dw_created (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS balance_samples (
      at INTEGER PRIMARY KEY, total REAL NOT NULL, granted REAL NOT NULL, topped_up REAL NOT NULL)`);
  }

  /** Add quantities to the lifetime totals. Zero-quantity lines are skipped. */
  record(lines: readonly Line[], atMs: number = Date.now()): void {
    for (const line of lines) {
      if (line.quantity === 0) continue;
      const period = periodFor(line.sku, atMs);
      this.sql.exec(
        `INSERT INTO usage_period (period, sku, quantity) VALUES (?, ?, ?)
         ON CONFLICT (period, sku) DO UPDATE SET quantity = quantity + excluded.quantity`,
        period, line.sku, line.quantity,
      );
      this.sql.exec(
        `INSERT INTO usage_totals (sku, service, unit, source, model, quantity) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (sku) DO UPDATE SET quantity = quantity + excluded.quantity`,
        line.sku, line.service, line.unit, line.source, line.model ?? null, line.quantity,
      );
    }
  }

  /** Totals for one period ("2026-11" or "2026-11-18"), keyed by SKU. */
  periodTotals(period: string): Record<string, number> {
    const rows = this.sql.exec("SELECT sku, quantity FROM usage_period WHERE period = ?", period).toArray();
    return Object.fromEntries(rows.map((r) => [String(r.sku), Number(r.quantity)]));
  }

  /** True the first time a Dynamic Worker (identified by its code hash) is seen in this UTC day. */
  markDynamicWorker(day: string, hash: string): boolean {
    const before = this.sql.exec("SELECT COUNT(*) AS n FROM dw_created WHERE day = ? AND hash = ?", day, hash).toArray();
    if (Number(before[0]?.n ?? 0) > 0) return false;
    this.sql.exec("INSERT INTO dw_created (day, hash) VALUES (?, ?)", day, hash);
    return true;
  }

  recordBalance(sample: BalanceSample): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO balance_samples (at, total, granted, topped_up) VALUES (?, ?, ?, ?)",
      sample.at, sample.total, sample.granted, sample.toppedUp,
    );
  }

  latestBalance(): BalanceSample | null {
    return this.balanceRow("SELECT * FROM balance_samples ORDER BY at DESC LIMIT 1");
  }

  /** The newest sample taken at or before `atMs`, used as the start of a rate window. */
  balanceAtOrBefore(atMs: number): BalanceSample | null {
    return this.balanceRow("SELECT * FROM balance_samples WHERE at <= ? ORDER BY at DESC LIMIT 1", atMs);
  }

  prune(nowMs: number): void {
    this.sql.exec("DELETE FROM dw_created WHERE day < ?", new Date(nowMs - 2 * 86_400_000).toISOString().slice(0, 10));
    this.sql.exec("DELETE FROM balance_samples WHERE at < ?", nowMs - RETAIN_MS);
  }

  /** Totals plus live lines (for example the secret count), which appear in the snapshot and are never stored. */
  snapshot(live: readonly Line[] = []): UsageSnapshot {
    const stored = this.sql.exec("SELECT * FROM usage_totals ORDER BY sku").toArray() as Array<Record<string, unknown>>;
    const rows: UsageRow[] = [
      ...stored.map((r) => ({
        sku: String(r.sku),
        service: r.service as Service,
        unit: String(r.unit),
        source: r.source as Source,
        quantity: Number(r.quantity),
        ...(r.model ? { model: String(r.model) } : {}),
      })),
      ...live.map((l) => ({ sku: l.sku, service: l.service, unit: l.unit, source: l.source, quantity: l.quantity, ...(l.model ? { model: l.model } : {}) })),
    ];

    const byModel: UsageSnapshot["byModel"] = {};
    for (const row of rows) {
      if (!row.model) continue;
      const m = (byModel[row.model] ??= { inputMiss: 0, inputHit: 0, output: 0, outputReasoning: 0, wallMs: 0, estimateUsd: 0 });
      if (row.sku.endsWith(".input_miss")) m.inputMiss += row.quantity;
      else if (row.sku.endsWith(".input_hit")) m.inputHit += row.quantity;
      else if (row.sku.endsWith(".output_reasoning")) m.outputReasoning += row.quantity;
      else if (row.sku.endsWith(".output")) m.output += row.quantity;
      else if (row.sku.endsWith(".wall_ms")) m.wallMs += row.quantity;
      else if (row.sku.endsWith(".estimate")) m.estimateUsd += row.quantity;
    }
    return { rows, byModel };
  }

  private balanceRow(query: string, ...bindings: unknown[]): BalanceSample | null {
    const r = this.sql.exec(query, ...bindings).toArray()[0];
    if (!r) return null;
    return { at: Number(r.at), total: Number(r.total), granted: Number(r.granted), toppedUp: Number(r.topped_up) };
  }
}
