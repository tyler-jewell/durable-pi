// DeepSeek tariffs, shared by host pi (through pi/extensions/deepseek-tariff.ts) and the Durable Object.
// The rates and the peak schedule live in pricing/deepseek.json. This module only reads them.
// Each request is priced at the tariff in force when it is sent. Cost is then computed by pi-ai itself
// (calculateCost), so pi's own usage.cost is the metric everything downstream reads.

import tariffJson from "../pricing/deepseek.json" with { type: "json" };
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Model } from "@earendil-works/pi-ai";

export type TariffName = "peak" | "offPeak";
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface Tariff {
  currency: string;
  verifiedOn: string;
  models: Record<string, Record<TariffName, Rates>>;
  schedule: { timezone: "UTC"; peak: Array<{ days: string; start: string; end: string }> };
}

export const TARIFF = tariffJson as Tariff;
export const DEEPSEEK_MODELS = Object.keys(TARIFF.models);

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** True when `atMs` falls in a peak window from pricing/deepseek.json (UTC, Monday to Friday). */
export function isPeak(atMs: number, tariff: Tariff = TARIFF): boolean {
  const d = new Date(atMs);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return tariff.schedule.peak.some((w) => minute >= toMinutes(w.start) && minute < toMinutes(w.end));
}

export const tariffAt = (atMs: number): TariffName => (isPeak(atMs) ? "peak" : "offPeak");

/** Catalog metadata (context window, output limit, capabilities) for a DeepSeek model, from pi-ai. */
let catalog: Map<string, Model<"openai-completions">> | undefined;
export function deepseekBase(modelId: string): Model<"openai-completions"> {
  catalog ??= new Map(deepseekProvider().getModels().map((m) => [m.id, m]));
  const base = catalog.get(modelId);
  if (!base) throw new Error(`pi-ai has no DeepSeek model ${modelId}`);
  return base;
}

/**
 * A pi-ai model object whose cost is the tariff in force at `atMs`. Passing it to `models.complete()` makes
 * pi-ai's calculateCost price the response at that tariff.
 */
export function deepseekModelAt(modelId: string, atMs: number): Model<"openai-completions"> {
  const rates = TARIFF.models[modelId]?.[tariffAt(atMs)];
  if (!rates) throw new Error(`no DeepSeek tariff for ${modelId}`);
  return { ...deepseekBase(modelId), cost: { ...rates } };
}
