// Cloudflare's rate card, read at runtime from the account's own subscriptions:
//   GET /accounts/{id}/subscriptions            -> the rate plans this account is on
//   GET /billing/rate_plans/{plan}              -> the plan's components, with tiers and included allowances
//
// Nothing here is a price. The unit prices come from the card at runtime, so a rate change needs no code change
// and no scheduled job. The one structural fact the code encodes is the unit convention, checked by the tests:
//
//   Convention: every component used here is priced per single unit (one request, one GB-s, one row, one
//   GB-month, one Dynamic Worker per day), in USD. The card rounds that unit price to six decimal places, so a
//   price below $0.000001 per unit shows as 0 or is rounded. `ROUNDING_USD_PER_UNIT` bounds that error.
//
// Included allowances: `cfStartOfFirstUnit` is the first billable unit (1-based), so the included amount is one less.

export const CF_API = "https://api.cloudflare.com/client/v4";

/** The components this app meters, by the name the rate card uses. */
export const DO_COMPONENT = {
  requests: "worker_durable_objects_requests",
  duration: "worker_durable_objects_duration",
  rowsRead: "worker_durable_objects_srs_storage_reads",
  rowsWritten: "worker_durable_objects_srs_storage_writes",
  storedData: "worker_durable_objects_srs_stored_data",
  dynamicWorkers: "dynamic_workers_daily",
} as const;
export type DoComponent = keyof typeof DO_COMPONENT;

/** The card rounds each unit price to six decimals, so the true price is within half of that step. */
export const ROUNDING_USD_PER_UNIT = 0.0000005;

export interface RateComponent {
  name: string;
  /** USD per single unit, as the card states it (already rounded by Cloudflare). */
  pricePerUnit: number;
  /** Units included before billing starts, per billing period (per day for dynamic workers). */
  includedUnits: number;
}

export interface RateCard {
  planId: string;
  components: Record<DoComponent, RateComponent>;
}

interface RawComponent {
  name: string;
  chargeModel?: string;
  cfStartOfFirstUnit?: number;
  tiers: Array<{ lowerThreshold: number; upperThreshold: number; price: number }>;
}
export interface RawPlan {
  id: string;
  currency: string;
  components: RawComponent[];
}

/** Turns a raw rate plan into the components this app meters. Throws on anything outside the convention. */
export function parseRateCard(plan: RawPlan): RateCard {
  if (plan.currency !== "USD") throw new Error(`rate plan ${plan.id} is in ${plan.currency}, not USD`);
  const components = {} as Record<DoComponent, RateComponent>;
  for (const [key, name] of Object.entries(DO_COMPONENT) as Array<[DoComponent, string]>) {
    const c = plan.components.find((x) => x.name === name);
    if (!c) throw new Error(`rate plan ${plan.id} has no component ${name}`);
    if (c.tiers.length !== 1 || c.tiers[0].lowerThreshold !== 0) {
      throw new Error(`${name} has a tier layout this app does not price (${c.tiers.length} tiers): add a convention first`);
    }
    components[key] = {
      name,
      pricePerUnit: c.tiers[0].price,
      includedUnits: Math.max(0, (c.cfStartOfFirstUnit ?? 1) - 1),
    };
  }
  return { planId: plan.id, components };
}

/**
 * Finds the rate plan that carries the Durable Objects components among this account's subscriptions, and parses it.
 * `fetchFn` is injected so tests run without the network.
 */
/** The subscription's billing period: allowances reset here, not on the calendar month. */
export interface BillingPeriod {
  /** ISO date-time of the period start, from the subscription. */
  start: string;
  end: string;
}

export async function fetchRateCard(
  accountId: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ card: RateCard; period: BillingPeriod }> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${CF_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: Array<{ message: string }> };
    if (!res.ok || body.success === false) {
      throw new Error(`${path} HTTP ${res.status}: ${body.errors?.[0]?.message ?? "no detail"}`);
    }
    return body.result as T;
  };

  const subscriptions = await get<Array<{ rate_plan?: { id?: string }; current_period_start?: string; current_period_end?: string }>>(
    `/accounts/${accountId}/subscriptions`,
  );
  for (const sub of subscriptions) {
    const planId = sub.rate_plan?.id;
    if (!planId) continue;
    const plan = await get<RawPlan>(`/billing/rate_plans/${encodeURIComponent(planId)}`);
    if (!plan.components?.some((c) => c.name === DO_COMPONENT.duration)) continue;
    if (!sub.current_period_start || !sub.current_period_end) throw new Error(`subscription ${planId} has no billing period`);
    return {
      card: parseRateCard(plan),
      period: { start: sub.current_period_start, end: sub.current_period_end },
    };
  }
  throw new Error("no subscription on this account carries the Durable Objects rate card");
}
