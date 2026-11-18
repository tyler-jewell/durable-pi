// The Cloudflare cost object for this Durable Object: telemetry for the current billing period, priced at the
// account's rate card. Pure functions, so the arithmetic runs under plain Node.
//
//   list cost   = every unit × the card's unit price          (free-tier OFF: as if no allowance applied)
//   actual cost = max(0, units − included) × unit price       (free-tier ON: "free-tier assumed")
//   band        = ± ROUNDING_USD_PER_UNIT per unit billed     (the card rounds unit prices to six decimals)
//
// Allowances reset on the billing period (the subscription's period), not the calendar month. Dynamic Workers
// are the exception: their included count applies to each UTC day, so they are billed day by day.

import { ROUNDING_USD_PER_UNIT, type BillingPeriod, type DoComponent, type RateCard } from "./cloudflare-rate-card.js";

/** Memory a Durable Object is allocated: 128 MB. Docs example: 1,000,000 s × 128 MB / 1 GB = 128,000 GB-s. */
export const DO_MEMORY_GB = 0.128;
/** A GB-month, in byte-minutes (decimal GB, 30-day month). */
const BYTE_MINUTES_PER_GB_MONTH = 1e9 * 30 * 24 * 60;

/** Period totals for the card's units. `dynamicWorkers` is the sum over the period; `dynamicDaily` keeps each day. */
export interface DoPeriodUsage {
  quantities: Record<DoComponent, number>;
  dynamicDaily: number[];
}

/** Sums the daily telemetry rows for the period [fromDay, toDay] into the card's units. */
export function doPeriodUsage(rows: Array<{ day: string; sku: string; quantity: number }>, fromDay: string, toDay: string): DoPeriodUsage {
  const inRange = rows.filter((r) => r.day >= fromDay && r.day <= toDay);
  const sum = (sku: string) => inRange.filter((r) => r.sku === sku).reduce((s, r) => s + r.quantity, 0);
  const dynamicDaily = inRange.filter((r) => r.sku === "dynamic_workers.created").map((r) => r.quantity);
  return {
    quantities: {
      requests: sum("durable_objects.requests"),
      duration: (sum("durable_objects.duration") / 1000) * DO_MEMORY_GB,
      rowsRead: sum("durable_objects.rows_read"),
      rowsWritten: sum("durable_objects.rows_written"),
      storedData: sum("storage.sqlite") / BYTE_MINUTES_PER_GB_MONTH,
      dynamicWorkers: dynamicDaily.reduce((s, n) => s + n, 0),
    },
    dynamicDaily,
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

export function cloudflareDoLines(card: RateCard, usage: DoPeriodUsage): CostLine[] {
  return (Object.keys(card.components) as DoComponent[]).map((component) => {
    const c = card.components[component];
    const quantity = usage.quantities[component];
    // Dynamic Workers: the included count applies per day, so billable units are summed day by day.
    const billableUnits =
      component === "dynamicWorkers"
        ? usage.dynamicDaily.reduce((s, n) => s + Math.max(0, n - c.includedUnits), 0)
        : Math.max(0, quantity - c.includedUnits);
    return {
      component,
      name: c.name,
      quantity,
      includedUnits: c.includedUnits,
      billableUnits,
      pricePerUnit: c.pricePerUnit,
      listUsd: quantity * c.pricePerUnit,
      actualUsd: billableUnits * c.pricePerUnit,
      bandUsd: 0, // filled in below, once the free-tier state is known
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
  /** The billing period the allowances reset on: from the subscription. */
  period: BillingPeriod | null;
  planId?: string;
  note?: string;
}

export function cloudflareDoView(input: {
  card: RateCard | null;
  period: BillingPeriod | null;
  usage: DoPeriodUsage;
  freeTier: boolean;
  asOf: number;
  note?: string;
}): CloudflareDoView {
  const basis = input.freeTier
    ? "free-tier assumed: usage inside the included allowance is free"
    : "list cost: every unit at the card's unit price, including the included allowance";
  const base = { id: "cloudflare-do" as const, label: "Cloudflare Durable Object", freeTier: input.freeTier, asOf: input.asOf, basis, period: input.period };

  if (!input.card) {
    return { ...base, usd: null, listUsd: null, actualUsd: null, bandUsd: null, lines: [], status: "unavailable", note: input.note ?? "no rate card yet" };
  }

  const lines = cloudflareDoLines(input.card, input.usage).map((l) => ({
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
