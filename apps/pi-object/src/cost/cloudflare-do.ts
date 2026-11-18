// The Cloudflare cost object for this Durable Object: telemetry quantities for the current billing period, priced
// at the rate card. Pure functions, so the arithmetic runs under plain Node.
//
//   list cost   = every unit × the card's unit price          (free-tier OFF: as if no allowance applied)
//   actual cost = max(0, units − included) × unit price       (free-tier ON: "free-tier assumed")
//   band        = ± ROUNDING_USD_PER_UNIT per unit billed     (the card rounds unit prices to six decimals)

import { ROUNDING_USD_PER_UNIT, type DoComponent, type RateCard } from "./cloudflare-rate-card.js";

/** Memory a Durable Object is allocated: 128 MB. Docs example: 1,000,000 s × 128 MB / 1 GB = 128,000 GB-s. */
export const DO_MEMORY_GB = 0.128;
/** A GB-month, in byte-minutes (decimal GB, 30-day month). */
const BYTE_MINUTES_PER_GB_MONTH = 1e9 * 30 * 24 * 60;

/** Quantities for one billing period, in the card's units. */
export type DoQuantities = Record<DoComponent, number>;

/** Maps the telemetry SKUs for one period to the card's units. */
export function doQuantities(totals: Record<string, number>): DoQuantities {
  return {
    requests: totals["durable_objects.requests"] ?? 0,
    duration: ((totals["durable_objects.duration"] ?? 0) / 1000) * DO_MEMORY_GB,
    rowsRead: totals["durable_objects.rows_read"] ?? 0,
    rowsWritten: totals["durable_objects.rows_written"] ?? 0,
    storedData: (totals["storage.sqlite"] ?? 0) / BYTE_MINUTES_PER_GB_MONTH,
    dynamicWorkers: totals["dynamic_workers.created"] ?? 0,
  };
}

export interface CostLine {
  component: DoComponent;
  name: string;
  quantity: number;
  includedUnits: number;
  billableUnits: number;
  pricePerUnit: number;
  listUsd: number;
  actualUsd: number;
  bandUsd: number;
}

export function cloudflareDoLines(card: RateCard, q: DoQuantities): CostLine[] {
  return (Object.keys(card.components) as DoComponent[]).map((component) => {
    const c = card.components[component];
    const quantity = q[component];
    const billableUnits = Math.max(0, quantity - c.includedUnits);
    return {
      component,
      name: c.name,
      quantity,
      includedUnits: c.includedUnits,
      billableUnits,
      pricePerUnit: c.pricePerUnit,
      listUsd: quantity * c.pricePerUnit,
      actualUsd: billableUnits * c.pricePerUnit,
      bandUsd: 0, // filled below, once the free-tier state is known
    };
  });
}

export interface CloudflareDoView {
  id: "cloudflare-do";
  label: string;
  freeTier: boolean;
  /** What the app bar shows: `actualUsd` with the free tier on, `listUsd` with it off. */
  usd: number | null;
  listUsd: number | null;
  actualUsd: number | null;
  bandUsd: number | null;
  lines: CostLine[];
  status: "ok" | "stale" | "unavailable";
  basis: string;
  asOf: number;
  planId?: string;
  note?: string;
}

export function cloudflareDoView(input: {
  card: RateCard | null;
  quantities: DoQuantities;
  freeTier: boolean;
  asOf: number;
  note?: string;
}): CloudflareDoView {
  const basis = input.freeTier
    ? "free-tier assumed: usage inside the included allowance is free"
    : "list cost: every unit at the card's unit price, including the included allowance";
  const base = { id: "cloudflare-do" as const, label: "Cloudflare Durable Object", freeTier: input.freeTier, asOf: input.asOf, basis };

  if (!input.card) {
    return { ...base, usd: null, listUsd: null, actualUsd: null, bandUsd: null, lines: [], status: "unavailable", note: input.note ?? "no rate card yet" };
  }

  const lines = cloudflareDoLines(input.card, input.quantities).map((l) => ({
    ...l,
    bandUsd: (input.freeTier ? l.billableUnits : l.quantity) * ROUNDING_USD_PER_UNIT,
  }));
  const listUsd = lines.reduce((s, l) => s + l.listUsd, 0);
  const actualUsd = lines.reduce((s, l) => s + l.actualUsd, 0);
  const bandUsd = lines.reduce((s, l) => s + l.bandUsd, 0);
  return {
    ...base,
    usd: input.freeTier ? actualUsd : listUsd,
    listUsd,
    actualUsd,
    bandUsd,
    lines,
    status: input.note ? "stale" : "ok",
    planId: input.card.planId,
    ...(input.note ? { note: input.note } : {}),
  };
}
