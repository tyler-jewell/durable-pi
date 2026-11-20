// The admin role's one-view snapshot of the Cloudflare account: the inventory the admin token can read, the
// account's billing subscription and rate card, and the last hour's measured usage priced at list price.
// Every part fails on its own. A part that cannot be read says why, and is never shown as an empty result.
export const CF_API = "https://api.cloudflare.com/client/v4";

/** The Durable Objects request component on the account's rate card, as Cloudflare names it. */
const DO_REQUESTS = "worker_durable_objects_requests";

export type FetchFn = typeof fetch;

export interface CfClient {
  rest(path: string): Promise<unknown>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

/** A REST and GraphQL client over one token. Throws on any HTTP or API error, with the API's own message. */
export function cfClient(token: string, fetchFn: FetchFn = fetch): CfClient {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const timeout = () => AbortSignal.timeout(20_000);
  return {
    async rest(path) {
      const res = await fetchFn(`${CF_API}${path}`, { headers, redirect: "error", signal: timeout() });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> };
      if (!res.ok || body.success === false) {
        const e = body.errors?.[0];
        throw new Error(`HTTP ${res.status}${e ? ` ${e.code ?? ""} ${e.message ?? ""}`.trimEnd() : ""}`);
      }
      return body.result;
    },
    async graphql(query, variables) {
      const res = await fetchFn(`${CF_API}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables }), redirect: "error", signal: timeout() });
      const body = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: Array<{ message?: string }> };
      if (!res.ok || body.errors?.length) throw new Error(`GraphQL HTTP ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""}`);
      return body.data;
    },
  };
}

export type Item = Record<string, string | number | boolean | null>;
export type Section<T extends Item = Item> = { ok: true; count: number; items: T[] } | { ok: false; error: string };

const rows = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

async function section<T extends Item>(load: () => Promise<T[]>): Promise<Section<T>> {
  try {
    const items = await load();
    return { ok: true, count: items.length, items };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface RateCardView {
  planId: string;
  /** USD per request on the rate card, and the requests included per billing period before billing starts. */
  doRequestsPricePerUnit: number;
  doRequestsIncluded: number;
}

/** The subscription whose rate plan carries the Durable Objects request component. Throws when none does. */
export async function rateCardOf(client: CfClient, accountId: string): Promise<RateCardView> {
  const subs = rows(await client.rest(`/accounts/${accountId}/subscriptions`));
  for (const sub of subs) {
    const planId = str((sub.rate_plan as { id?: unknown } | undefined)?.id);
    if (!planId) continue;
    const plan = (await client.rest(`/billing/rate_plans/${encodeURIComponent(planId)}`)) as { components?: Array<Record<string, unknown>> };
    const c = (plan.components ?? []).find((x) => x.name === DO_REQUESTS);
    if (!c) continue;
    const tiers = (c.tiers ?? []) as Array<{ lowerThreshold?: number; price?: number }>;
    if (tiers.length !== 1 || tiers[0].lowerThreshold !== 0 || typeof tiers[0].price !== "number") {
      throw new Error(`${DO_REQUESTS} on plan ${planId} has a tier layout this snapshot does not price`);
    }
    return { planId, doRequestsPricePerUnit: tiers[0].price, doRequestsIncluded: Math.max(0, Number(c.cfStartOfFirstUnit ?? 1) - 1) };
  }
  throw new Error("no subscription on this account carries the Durable Objects rate card");
}

export interface LastHour {
  from: string;
  to: string;
  usage: { workers: { requests: number; errors: number } | { error: string }; durableObjects: { requests: number } | { error: string } };
  priced: Array<{ product: string; units: number; pricePerUnitUsd: number; listCostUsd: number }>;
  unpriced: Array<{ product: string; units: number; reason: string }>;
  /** Sum of the priced lines, at list price, before included allowances. */
  estimatedListUsd: number;
  /** False when any usage could not be measured or priced, so the total is a floor, not the full hour. */
  complete: boolean;
  note: string;
}

const USAGE_QUERY = `query Usage($tag: string, $from: string, $to: string) { viewer { accounts(filter: { accountTag: $tag }) {
  workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }) { sum { requests errors } }
  durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }) { sum { requests } }
} } }`;

/** The last hour's measured requests, priced at list price where the rate card has a verified component for them. */
export async function lastHourOf(client: CfClient, accountId: string, now: Date, rate: RateCardView | undefined, rateError: string | undefined): Promise<LastHour> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 3_600_000).toISOString();
  const note = "List price before included allowances. Cloudflare bills per billing period, so this is a measured hour priced by the account's own rate card, not an invoice line.";
  const out: LastHour = { from, to, usage: { workers: { error: "not queried" }, durableObjects: { error: "not queried" } }, priced: [], unpriced: [], estimatedListUsd: 0, complete: true, note };
  let data: { viewer?: { accounts?: Array<Record<string, { sum?: Record<string, number> }[]>> } } | undefined;
  try {
    data = (await client.graphql(USAGE_QUERY, { tag: accountId, from, to })) as typeof data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.usage = { workers: { error: message }, durableObjects: { error: message } };
    out.complete = false;
    return out;
  }
  const acct = data?.viewer?.accounts?.[0] ?? {};
  const total = (groups: Array<{ sum?: Record<string, number> }> | undefined, field: string) => (groups ?? []).reduce((n, g) => n + Number(g.sum?.[field] ?? 0), 0);
  const workers = acct.workers as Array<{ sum?: Record<string, number> }> | undefined;
  const dos = acct.durableObjects as Array<{ sum?: Record<string, number> }> | undefined;
  const wRequests = total(workers, "requests");
  const dRequests = total(dos, "requests");
  out.usage = { workers: { requests: wRequests, errors: total(workers, "errors") }, durableObjects: { requests: dRequests } };
  if (dRequests > 0) {
    if (rate) {
      const listCostUsd = dRequests * rate.doRequestsPricePerUnit;
      out.priced.push({ product: "Durable Objects requests", units: dRequests, pricePerUnitUsd: rate.doRequestsPricePerUnit, listCostUsd });
    } else {
      out.unpriced.push({ product: "Durable Objects requests", units: dRequests, reason: rateError ?? "no rate card" });
    }
  }
  if (wRequests > 0) out.unpriced.push({ product: "Workers requests", units: wRequests, reason: "no verified rate-card component for Workers requests yet" });
  out.estimatedListUsd = out.priced.reduce((n, p) => n + p.listCostUsd, 0);
  out.complete = out.unpriced.length === 0;
  return out;
}

export interface SnapshotInput {
  client: CfClient;
  accountId: string;
  /** The zone whose DNS records are counted, by name. Undefined means no zone is configured, and DNS is reported so. */
  zoneName?: string;
  now?: Date;
}

export interface Snapshot {
  generatedAt: string;
  account: { id: string; name: string } | { id: string; error: string };
  inventory: Record<string, Section>;
  billing: { subscriptions: Section; rateCard: Section; lastHour: LastHour };
}

/** One view of the account: every inventory section, billing, and the last hour's usage and cost. */
export async function cloudflareSnapshot(input: SnapshotInput): Promise<Snapshot> {
  const { client, accountId } = input;
  const now = input.now ?? new Date();
  const a = `/accounts/${accountId}`;

  const account = await (async (): Promise<Snapshot["account"]> => {
    try {
      const r = (await client.rest(a)) as { name?: unknown };
      return { id: accountId, name: str(r.name) };
    } catch (error) {
      return { id: accountId, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  const dns = async (): Promise<Item[]> => {
    if (!input.zoneName) throw new Error("no zone configured: pass zone, or set DPI_PRIMARY_ZONE");
    const zone = rows(await client.rest(`/zones?name=${encodeURIComponent(input.zoneName)}`))[0];
    if (!zone) throw new Error("no zone with that name on this token");
    const records = rows(await client.rest(`/zones/${str(zone.id)}/dns_records?per_page=100`));
    const byType = new Map<string, number>();
    for (const r of records) byType.set(str(r.type), (byType.get(str(r.type)) ?? 0) + 1);
    return [...byType].map(([type, count]) => ({ type, count }));
  };

  const [workers, dos, r2, kv, d1, queues, tunnels, apps, serviceTokens, dnsRecords] = await Promise.all([
    section(async () => rows(await client.rest(`${a}/workers/scripts?per_page=100`)).map((r) => ({ name: str(r.id), modified: str(r.modified_on) }))),
    section(async () => rows(await client.rest(`${a}/workers/durable_objects/namespaces`)).map((r) => ({ name: str(r.name), script: str(r.script), class: str(r.class), id: str(r.id) }))),
    section(async () => {
      const v = (await client.rest(`${a}/r2/buckets`)) as unknown;
      const list = Array.isArray(v) ? v : ((v as { buckets?: unknown })?.buckets ?? []);
      return rows(list).map((r) => ({ name: str(r.name), created: str(r.creation_date) }));
    }),
    section(async () => rows(await client.rest(`${a}/storage/kv/namespaces?per_page=100`)).map((r) => ({ title: str(r.title), id: str(r.id) }))),
    section(async () => rows(await client.rest(`${a}/d1/database?per_page=100`)).map((r) => ({ name: str(r.name), id: str(r.uuid), created: str(r.created_at) }))),
    section(async () => rows(await client.rest(`${a}/queues`)).map((r) => ({ name: str(r.queue_name), id: str(r.queue_id) }))),
    section(async () => rows(await client.rest(`${a}/cfd_tunnel?is_deleted=false`)).map((r) => ({ name: str(r.name), id: str(r.id), status: str(r.status), created: str(r.created_at) }))),
    section(async () => rows(await client.rest(`${a}/access/apps?per_page=100`)).map((r) => ({ name: str(r.name), domain: str(r.domain), type: str(r.type) }))),
    section(async () => rows(await client.rest(`${a}/access/service_tokens?per_page=100`)).map((r) => ({ name: str(r.name), expires: str(r.expires_at) }))),
    section(dns),
  ]);

  const subscriptions = await section(async () =>
    rows(await client.rest(`${a}/subscriptions`)).map((s) => ({
      planId: str((s.rate_plan as { id?: unknown } | undefined)?.id),
      periodStart: str(s.current_period_start),
      periodEnd: str(s.current_period_end),
    })),
  );

  let rate: RateCardView | undefined;
  let rateError: string | undefined;
  try {
    rate = await rateCardOf(client, accountId);
  } catch (error) {
    rateError = error instanceof Error ? error.message : String(error);
  }
  const rateCard: Section = rate
    ? { ok: true, count: 1, items: [{ planId: rate.planId, doRequestsPricePerUnit: rate.doRequestsPricePerUnit, doRequestsIncluded: rate.doRequestsIncluded }] }
    : { ok: false, error: rateError ?? "no rate card" };

  const lastHour = await lastHourOf(client, accountId, now, rate, rateError);

  return {
    generatedAt: now.toISOString(),
    account,
    inventory: { workers, durableObjects: dos, r2Buckets: r2, kvNamespaces: kv, d1Databases: d1, queues, tunnels, accessApps: apps, serviceTokens, dnsRecords },
    billing: { subscriptions, rateCard, lastHour },
  };
}
