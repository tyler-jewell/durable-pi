// Local + cloud cost accounting. A call records its interval, tokens and (for cloud) the
// billable token cost. Two reports close the loop:
//   computeUsage  — local kWh (idle power + load power over the UNION of call intervals),
//                   cost at the configured electricity price.
//   compareCosts  — per model: the cloud $/min run rate (billable cost ÷ minutes), and the
//                   local opportunity cost — the wait-time difference vs cloud, valued at the
//                   cloud rate, credited when local is faster. Local electricity + opportunity
//                   is the "effective local cost" to weigh against the cloud bill.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "./policy.js";

export type Transport = "openai-compat" | "cloudflare-workers-ai";

export interface CostSettings {
  electricityUsdPerKwh: number;
  idleWatts: number;
  loadWatts: number;
}

export const DEFAULT_SETTINGS: CostSettings = { electricityUsdPerKwh: 0.15, idleWatts: 30, loadWatts: 80 };

export interface UsageRecord {
  startedAt: number;
  endedAt: number;
  model: string; // canonical family name, shared by the local + cloud twin
  kind: "llm" | "decision";
  transport: Transport;
  inToks: number;
  outToks: number;
  costUsd: number; // billable token cost (cloud only); 0 for local
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

export function recordUsage(meter: UsageMeter, call: UsageRecord): UsageMeter {
  meter.calls.push(call);
  const keepAfter = call.endedAt - loadPolicy().retentionDays.meter * 24 * 60 * 60 * 1000;
  meter.calls = meter.calls.filter((entry) => entry.endedAt >= keepAfter);
  saveMeter(meter);
  return meter;
}

/** Marginal electricity for `ms` of model time: the power above idle, priced per kWh. Idle draw is not
 *  charged here, because a cloud call has no idle equivalent. This is the realized spend of one run. */
export function marginalElectricityUsd(ms: number, settings: CostSettings): number {
  const kwh = ((settings.loadWatts - settings.idleWatts) * (ms / 1000)) / 3_600_000;
  return kwh * settings.electricityUsdPerKwh;
}

export interface UsageSummary {
  loadSeconds: number;
  elapsedSeconds: number;
  kwh: number;
  costUsd: number;
  callCount: number;
  settings: CostSettings;
}

export function computeUsage(meter: UsageMeter, now = Date.now()): UsageSummary {
  const local = meter.calls.filter((c) => c.transport === "openai-compat");
  const intervals = [...local].sort((a, b) => a.startedAt - b.startedAt).map((c) => [c.startedAt, c.endedAt] as const);
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
  return { loadSeconds, elapsedSeconds: elapsed, kwh, costUsd: kwh * meter.settings.electricityUsdPerKwh, callCount: local.length, settings: meter.settings };
}

export interface ModelCostComparison {
  model: string;
  kind: "llm" | "decision";
  cloud: { calls: number; costUsd: number; avgMs: number; rateUsdPerMin: number };
  local: { calls: number; electricityUsd: number; avgMs: number; opportunityUsd: number };
  /** Realized dollars saved by running local instead of cloud: cloud bill − local electricity.
   *  The wait-time `opportunityUsd` is NOT included — it is time-valued, not realized spend. */
  realizedSavingsUsd: number;
  /** electricity + opportunity (the time-valued wait-time at the cloud rate), for completeness. */
  effectiveLocalUsd: number;
  verdict: "local" | "cloud" | "tie";
}

/** Compare local vs cloud per model family: cloud $/min rate, local wait-time opportunity cost. */
export function compareCosts(meter: UsageMeter): ModelCostComparison[] {
  const byModel = new Map<string, UsageRecord[]>();
  for (const c of meter.calls) {
    const list = byModel.get(c.model) ?? [];
    list.push(c);
    byModel.set(c.model, list);
  }
  const out: ModelCostComparison[] = [];
  for (const [model, calls] of byModel) {
    const cloud = calls.filter((c) => c.transport === "cloudflare-workers-ai");
    const local = calls.filter((c) => c.transport === "openai-compat");
    if (!cloud.length || !local.length) continue; // only compare when both twins ran
    const cloudCost = cloud.reduce((a, c) => a + c.costUsd, 0);
    const cloudMs = cloud.reduce((a, c) => a + (c.endedAt - c.startedAt), 0) / cloud.length;
    const localMs = local.reduce((a, c) => a + (c.endedAt - c.startedAt), 0) / local.length;
    const rateUsdPerMin = cloudMs > 0 ? (cloudCost / (cloudMs / 60_000)) : 0;
    const marginalW = meter.settings.loadWatts - meter.settings.idleWatts;
    const electricityUsd = local.reduce((a, c) => a + (marginalW * (c.endedAt - c.startedAt)) / 3_600_000_000, 0) * meter.settings.electricityUsdPerKwh;
    const opportunityUsd = (rateUsdPerMin * (localMs - cloudMs)) / 60_000; // negative when local is faster (credit)
    const effectiveLocalUsd = electricityUsd + opportunityUsd;
    const realizedSavingsUsd = cloudCost - electricityUsd; // realized spend saved, opportunity excluded
    out.push({
      model,
      kind: calls[0].kind,
      cloud: { calls: cloud.length, costUsd: cloudCost, avgMs: cloudMs, rateUsdPerMin },
      local: { calls: local.length, electricityUsd, avgMs: localMs, opportunityUsd },
      realizedSavingsUsd,
      effectiveLocalUsd,
      verdict: realizedSavingsUsd > 0 ? "local" : realizedSavingsUsd < 0 ? "cloud" : "tie",
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}
