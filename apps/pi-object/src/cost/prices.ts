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
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
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
  /**
   * DeepSeek per million tokens. Peak and off-peak rates from the pricing page (off-peak is half of peak).
   * `inputMiss` is uncached prompt tokens, `inputHit` is cache-hit prompt tokens, `output` includes reasoning.
   */
  deepseek: {
    "deepseek-flash": {
      inputMiss: { peak: 0.3, offPeak: 0.15 },
      inputHit: { peak: 0.006, offPeak: 0.003 },
      output: { peak: 1.2, offPeak: 0.6 },
    },
    "deepseek-v4-pro": {
      inputMiss: { peak: 1.32, offPeak: 0.66 },
      inputHit: { peak: 0.044, offPeak: 0.022 },
      output: { peak: 3.96, offPeak: 1.98 },
    },
  },
} as const;

/**
 * DeepSeek peak window: 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. Chinese public holidays are
 * also peak; that calendar is not available offline, so holidays are a known limitation (see the README).
 */
export function isDeepSeekPeak(atMs: number): boolean {
  const d = new Date(atMs);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
