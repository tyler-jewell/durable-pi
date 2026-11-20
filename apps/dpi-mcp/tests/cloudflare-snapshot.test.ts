import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareSnapshot, type CfClient, type Snapshot } from "../src/cloudflare-snapshot.js";

const ACC = "acc-0123";
const NOW = new Date("2026-11-20T12:00:00.000Z");

/** A client whose REST routes and GraphQL answer are given by the test. An Error value makes that route fail. */
function fakeClient(routes: Record<string, unknown>, gql: unknown): CfClient {
  return {
    async rest(path) {
      const key = path.split("?")[0];
      if (!(key in routes)) throw new Error(`no route for ${key}`);
      const v = routes[key];
      if (v instanceof Error) throw v;
      return v;
    },
    async graphql() {
      if (gql instanceof Error) throw gql;
      return gql;
    },
  };
}

const rateRoutes = {
  [`/accounts/${ACC}/subscriptions`]: [{ rate_plan: { id: "plan-1" }, current_period_start: "2026-11-01", current_period_end: "2026-12-01" }],
  "/billing/rate_plans/plan-1": {
    components: [
      { name: "worker_durable_objects_requests", cfStartOfFirstUnit: 1000001, tiers: [{ lowerThreshold: 0, price: 0.0000015 }] },
    ],
  },
};

const baseRoutes: Record<string, unknown> = {
  [`/accounts/${ACC}`]: { name: "personal" },
  [`/accounts/${ACC}/workers/scripts`]: [{ id: "app-a", modified_on: "2026-11-19" }, { id: "app-b", modified_on: "2026-11-20" }],
  [`/accounts/${ACC}/workers/durable_objects/namespaces`]: [{ name: "Counter", script: "app-a", class: "Counter", id: "ns1" }],
  [`/accounts/${ACC}/r2/buckets`]: { buckets: [{ name: "archive", creation_date: "2026-11-01" }] },
  [`/accounts/${ACC}/storage/kv/namespaces`]: [],
  [`/accounts/${ACC}/d1/database`]: [],
  [`/accounts/${ACC}/queues`]: [],
  [`/accounts/${ACC}/cfd_tunnel`]: [],
  [`/accounts/${ACC}/access/apps`]: [{ name: "studio", domain: "studio.example", type: "self_hosted" }],
  [`/accounts/${ACC}/access/service_tokens`]: [{ name: "mesh", expires_at: "2027-11-20" }],
  "/zones": [{ id: "zone-1" }],
  "/zones/zone-1/dns_records": [{ type: "CNAME" }, { type: "CNAME" }, { type: "TXT" }],
  ...rateRoutes,
};

const gqlHour = (workers: number, dos: number) => ({
  viewer: { accounts: [{ workers: [{ sum: { requests: workers, errors: 0 } }], durableObjects: [{ sum: { requests: dos } }] }] },
});

async function snap(routes: Record<string, unknown>, gql: unknown, zone: string | undefined = "example.com"): Promise<Snapshot> {
  return cloudflareSnapshot({ client: fakeClient(routes, gql), accountId: ACC, zoneName: zone, now: NOW });
}

test("the snapshot shows every section with its count and the account name", async () => {
  const s = await snap(baseRoutes, gqlHour(0, 1000));
  assert.deepEqual(s.account, { id: ACC, name: "personal" });
  assert.equal(s.inventory.workers.ok && s.inventory.workers.count, 2);
  assert.equal(s.inventory.durableObjects.ok && s.inventory.durableObjects.count, 1);
  assert.equal(s.inventory.r2Buckets.ok && s.inventory.r2Buckets.count, 1, "R2 buckets are read from the buckets field");
  assert.deepEqual(s.inventory.dnsRecords.ok && s.inventory.dnsRecords.items, [{ type: "CNAME", count: 2 }, { type: "TXT", count: 1 }]);
  assert.equal(s.billing.rateCard.ok, true);
});

test("the last hour is priced at list price, and complete when nothing is unpriced", async () => {
  const s = await snap(baseRoutes, gqlHour(0, 1000));
  const h = s.billing.lastHour;
  assert.equal(h.complete, true);
  assert.deepEqual(h.priced, [{ product: "Durable Objects requests", units: 1000, pricePerUnitUsd: 0.0000015, listCostUsd: 0.0015 }]);
  assert.equal(h.estimatedListUsd, 0.0015);
  assert.equal(h.from, "2026-11-20T11:00:00.000Z");
  assert.equal(h.to, NOW.toISOString());
});

test("Workers requests with no verified price make the hour incomplete, never zero", async () => {
  const s = await snap(baseRoutes, gqlHour(500, 0));
  assert.equal(s.billing.lastHour.complete, false);
  assert.equal(s.billing.lastHour.unpriced[0].product, "Workers requests");
  assert.equal(s.billing.lastHour.unpriced[0].units, 500);
});

test("a section that cannot be read says why, and the others still show", async () => {
  const s = await snap({ ...baseRoutes, [`/accounts/${ACC}/cfd_tunnel`]: new Error("HTTP 403 10000 Authentication error") }, gqlHour(0, 0));
  assert.deepEqual(s.inventory.tunnels, { ok: false, error: "HTTP 403 10000 Authentication error" });
  assert.equal(s.inventory.workers.ok, true);
});

test("no zone configured is reported as such, not as zero DNS records", async () => {
  const s = await cloudflareSnapshot({ client: fakeClient(baseRoutes, gqlHour(0, 0)), accountId: ACC, now: NOW });
  assert.equal(s.inventory.dnsRecords.ok, false);
  if (!s.inventory.dnsRecords.ok) assert.match(s.inventory.dnsRecords.error, /DPI_PRIMARY_ZONE/);
});

test("a failed usage query leaves the hour incomplete and says so for every product", async () => {
  const s = await snap(baseRoutes, new Error("GraphQL HTTP 403: not authorized"));
  assert.equal(s.billing.lastHour.complete, false);
  assert.deepEqual(s.billing.lastHour.usage.workers, { error: "GraphQL HTTP 403: not authorized" });
  assert.deepEqual(s.billing.lastHour.usage.durableObjects, { error: "GraphQL HTTP 403: not authorized" });
});

test("without a rate card, Durable Objects usage is measured but unpriced", async () => {
  const routes = { ...baseRoutes, [`/accounts/${ACC}/subscriptions`]: [] };
  const s = await snap(routes, gqlHour(0, 1000));
  assert.equal(s.billing.rateCard.ok, false);
  assert.equal(s.billing.lastHour.complete, false);
  assert.equal(s.billing.lastHour.priced.length, 0);
  assert.match(s.billing.lastHour.unpriced[0].reason, /no subscription/);
});
