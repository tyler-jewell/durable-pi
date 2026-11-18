// Persists the cost ledger in SQLite. Lifetime totals are one row per SKU, so reads stay O(SKUs) however long
// the agent runs. The per-minute series is kept for 48 hours and then pruned. Written against a minimal SQL
// interface, so the same code runs in a Durable Object (ctx.storage.sql) and in Node tests.

import type { Line, Service } from "./meter.js";
import { PRICEBOOK_VERSION } from "./prices.js";

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export const SERIES_MINUTES = 60;
const RETAIN_MINUTES = 48 * 60;

export interface Snapshot {
  pricebook: string;
  asOf: number;
  totalUsd: number;
  byService: Partial<Record<Service, number>>;
  byModel: Record<string, { usd: number; inputMissTokens: number; inputHitTokens: number; outputTokens: number }>;
  lines: Array<Omit<Line, "model"> & { model?: string; usd: number }>;
  /** USD per minute for the last SERIES_MINUTES minutes (oldest first), with zero minutes filled in. */
  series: Array<{ minute: number; usd: number }>;
  /** USD per hour over the last five minutes. */
  usdPerHour: number;
}

export class CostStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(`CREATE TABLE IF NOT EXISTS cost_totals (
      sku TEXT PRIMARY KEY, service TEXT NOT NULL, unit TEXT NOT NULL, precision TEXT NOT NULL,
      model TEXT, quantity REAL NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cost_minute (
      minute INTEGER NOT NULL, sku TEXT NOT NULL, service TEXT NOT NULL, unit TEXT NOT NULL,
      precision TEXT NOT NULL, model TEXT, quantity REAL NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (minute, sku))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS dw_created (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash))`);
  }

  /** Add priced lines to the ledger at `atMs`. Zero-quantity lines are skipped. */
  record(lines: readonly Line[], atMs: number): void {
    const minute = Math.floor(atMs / 60_000);
    for (const line of lines) {
      if (line.quantity === 0 && line.usd === 0) continue;
      const model = line.model ?? null;
      this.sql.exec(
        `INSERT INTO cost_totals (sku, service, unit, precision, model, quantity, usd) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sku) DO UPDATE SET quantity = quantity + excluded.quantity, usd = usd + excluded.usd`,
        line.sku, line.service, line.unit, line.precision, model, line.quantity, line.usd,
      );
      this.sql.exec(
        `INSERT INTO cost_minute (minute, sku, service, unit, precision, model, quantity, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (minute, sku) DO UPDATE SET quantity = quantity + excluded.quantity, usd = usd + excluded.usd`,
        minute, line.sku, line.service, line.unit, line.precision, model, line.quantity, line.usd,
      );
    }
  }

  /** True the first time a Dynamic Worker (identified by its code hash) is seen in this UTC day. */
  markDynamicWorker(day: string, hash: string): boolean {
    const before = this.sql.exec("SELECT COUNT(*) AS n FROM dw_created WHERE day = ? AND hash = ?", day, hash).toArray();
    if (Number(before[0]?.n ?? 0) > 0) return false;
    this.sql.exec("INSERT INTO dw_created (day, hash) VALUES (?, ?)", day, hash);
    return true;
  }

  prune(nowMs: number): void {
    const cutoff = Math.floor(nowMs / 60_000) - RETAIN_MINUTES;
    this.sql.exec("DELETE FROM cost_minute WHERE minute < ?", cutoff);
    const day = new Date(nowMs - 2 * 86_400_000).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM dw_created WHERE day < ?", day);
  }

  /** Live lines describe the current footprint (for example the secret count). They appear in the snapshot and are never stored. */
  snapshot(nowMs: number, live: readonly Line[] = []): Snapshot {
    const totals = this.sql.exec("SELECT * FROM cost_totals ORDER BY sku").toArray() as Array<Record<string, unknown>>;

    const stored: Snapshot["lines"] = totals.map((r) => ({
      service: r.service as Service,
      sku: String(r.sku),
      unit: String(r.unit),
      quantity: Number(r.quantity),
      usd: Number(r.usd),
      precision: r.precision as Snapshot["lines"][number]["precision"],
      ...(r.model ? { model: String(r.model) } : {}),
    }));
    const lines: Snapshot["lines"] = [...stored, ...live.map((l) => ({ ...l }))];

    const byService: Snapshot["byService"] = {};
    const byModel: Snapshot["byModel"] = {};
    let totalUsd = 0;
    for (const line of lines) {
      totalUsd += line.usd;
      byService[line.service] = (byService[line.service] ?? 0) + line.usd;
      if (line.model) {
        const m = (byModel[line.model] ??= { usd: 0, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0 });
        m.usd += line.usd;
        if (line.sku.endsWith(".input_miss")) m.inputMissTokens += line.quantity;
        if (line.sku.endsWith(".input_hit")) m.inputHitTokens += line.quantity;
        if (line.sku.endsWith(".output")) m.outputTokens += line.quantity;
      }
    }

    const fromMinute = Math.floor(nowMs / 60_000) - SERIES_MINUTES + 1;
    const rows = this.sql
      .exec("SELECT minute, SUM(usd) AS usd FROM cost_minute WHERE minute >= ? GROUP BY minute", fromMinute)
      .toArray() as Array<{ minute: number; usd: number }>;
    const perMinute = new Map(rows.map((r) => [Number(r.minute), Number(r.usd)]));
    const series: Snapshot["series"] = [];
    for (let m = fromMinute; m <= Math.floor(nowMs / 60_000); m++) series.push({ minute: m, usd: perMinute.get(m) ?? 0 });

    const recent = series.slice(-5).reduce((sum, p) => sum + p.usd, 0);

    return {
      pricebook: PRICEBOOK_VERSION,
      asOf: nowMs,
      totalUsd,
      byService,
      byModel,
      lines,
      series,
      usdPerHour: (recent / 5) * 60,
    };
  }
}
