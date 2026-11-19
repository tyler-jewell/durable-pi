// Local cost meter: robust kWh accounting for the Studio's power draw across model calls.
// A call records its interval; the load seconds are the UNION of intervals (concurrent calls
// share the load, so they never double-count). Cost = kWh x the global electricity price.
// Settings (price/kWh, idle watts, load watts) are editable via the update_settings tool.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CostSettings {
  /** Global electricity price, USD per kWh (editable in settings). */
  electricityUsdPerKwh: number;
  /** System power draw when no model is generating. */
  idleWatts: number;
  /** System power draw while a model is generating. */
  loadWatts: number;
}

export const DEFAULT_SETTINGS: CostSettings = { electricityUsdPerKwh: 0.15, idleWatts: 30, loadWatts: 80 };

export interface UsageRecord {
  startedAt: number;
  endedAt: number;
  model: string;
  kind: "llm" | "decision";
}

export interface UsageMeter {
  startedAt: number;
  calls: UsageRecord[];
  settings: CostSettings;
}

const METER = process.env.DPI_MCP_METER ?? join(homedir(), ".dpi-mcp", "usage.json");

export function loadMeter(): UsageMeter {
  try {
    const m = JSON.parse(readFileSync(METER, "utf8")) as Partial<UsageMeter>;
    return { startedAt: m.startedAt ?? Date.now(), calls: m.calls ?? [], settings: { ...DEFAULT_SETTINGS, ...(m.settings ?? {}) } };
  } catch {
    return { startedAt: Date.now(), calls: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

export function saveMeter(meter: UsageMeter): void {
  mkdirSync(join(homedir(), ".dpi-mcp"), { recursive: true });
  writeFileSync(METER, JSON.stringify(meter, null, 2) + "\n");
}

/** Record one local model call and persist the meter. */
export function recordUsage(meter: UsageMeter, call: UsageRecord): UsageMeter {
  meter.calls.push(call);
  saveMeter(meter);
  return meter;
}

export interface UsageSummary {
  loadSeconds: number;
  elapsedSeconds: number;
  kwh: number;
  costUsd: number;
  callCount: number;
  settings: CostSettings;
}

/**
 * Total kWh + cost from the power model. Load seconds are the union of call intervals, so
 * overlapping calls (parallel models) share the load instead of double-counting it.
 */
export function computeUsage(meter: UsageMeter, now = Date.now()): UsageSummary {
  const intervals = [...meter.calls].sort((a, b) => a.startedAt - b.startedAt).map((c) => [c.startedAt, c.endedAt] as const);
  let loadSeconds = 0;
  let curStart = 0;
  let curEnd = 0;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      loadSeconds += (curEnd - curStart) / 1000;
      curStart = s;
      curEnd = e;
    } else {
      curEnd = Math.max(curEnd, e);
    }
  }
  loadSeconds += (curEnd - curStart) / 1000;
  const elapsed = Math.max(0, now - meter.startedAt) / 1000;
  const kwh = (meter.settings.idleWatts * elapsed + (meter.settings.loadWatts - meter.settings.idleWatts) * loadSeconds) / 3_600_000;
  return { loadSeconds, elapsedSeconds: elapsed, kwh, costUsd: kwh * meter.settings.electricityUsdPerKwh, callCount: meter.calls.length, settings: meter.settings };
}
