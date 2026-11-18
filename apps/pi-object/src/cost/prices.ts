// The price book: every rate this app meters, with its source. Rates are USD list prices.
// Free allowances (included monthly usage, the Workers Paid subscription) are account-level, so they
// are not applied per Durable Object: a DO's cost is its gross usage at list price, and the account
// rollup subtracts allowances. Change a rate by adding a new PRICEBOOK version, never by editing in place,
// so historical ledger entries keep the price that was in force when they were recorded.

export const PRICEBOOK_VERSION = "2026-11-18";

export const SOURCES = {
  durableObjects: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  workers: "https://developers.cloudflare.com/workers/platform/pricing/",
  dynamicWorkers: "https://developers.cloudflare.com/dynamic-workers/pricing/",
  secrets: "https://developers.cloudflare.com/workers/configuration/secrets/",
} as const;

export const PRICES = {
  durableObjects: {
    /** Per million billable requests (HTTP, RPC sessions, WebSocket messages, alarms). */
    requestsPerMillion: 0.15,
    /** Per million GB-seconds of active duration. */
    gbSecondsPerMillion: 12.5,
    /** Durable Object memory allocation: 128 MB, so each active second is 0.125 GB-s. */
    memoryGb: 0.125,
    /** Per million rows read / written in SQLite storage. */
    rowsReadPerMillion: 0.001,
    rowsWrittenPerMillion: 1.0,
    /** Per GB-month of SQLite stored data. */
    storageGbMonth: 0.2,
  },
  workers: {
    requestsPerMillion: 0.3,
    cpuMsPerMillion: 0.02,
  },
  dynamicWorkers: {
    /** Per unique Dynamic Worker (Worker ID + code) created in a UTC day. */
    createdPerWorkerPerDay: 0.002,
    requestsPerMillion: 0.3,
    cpuMsPerMillion: 0.02,
  },
  /** Secrets are not billed. They are listed in the cost stream so their footprint is visible. */
  secrets: { perSecret: 0 },
} as const;

