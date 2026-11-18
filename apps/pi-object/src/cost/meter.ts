// Pure metering arithmetic. No I/O: the Durable Object feeds it counters and it returns priced ledger lines,
// so every rule here runs under plain Node tests.

import { isDeepSeekPeak, PRICES } from "./prices.js";

/**
 * How a quantity was obtained. "exact": provider-reported counts at a published price.
 * "measured": counted in-band by this app. "estimated": an upper bound (wall-clock stands in for CPU time).
 */
export type Precision = "exact" | "measured" | "estimated";

export type Service =
  | "llm"
  | "durable_objects"
  | "workers"
  | "dynamic_workers"
  | "storage"
  | "secrets"
  | "tools";

export interface Line {
  service: Service;
  /** Stable key: service.resource.unit, e.g. "llm.deepseek.deepseek-flash.output". */
  sku: string;
  unit: string;
  quantity: number;
  usd: number;
  precision: Precision;
  /** Set for LLM lines, so the stream can break cost down by model. */
  model?: string;
}

export interface LlmUsage {
  /** Uncached prompt tokens (pi-ai's `input`). */
  input: number;
  /** Cache-hit prompt tokens (pi-ai's `cacheRead`). */
  cacheRead: number;
  /** Completion tokens, reasoning included (pi-ai's `output` already contains reasoning). */
  output: number;
}

const perMillion = (quantity: number, rate: number) => (quantity / 1_000_000) * rate;

export function deepseekLines(model: keyof typeof PRICES.deepseek, usage: LlmUsage, atMs: number): Line[] {
  const rates = PRICES.deepseek[model];
  const peak = isDeepSeekPeak(atMs);
  const pick = (r: { peak: number; offPeak: number }) => (peak ? r.peak : r.offPeak);
  const id = `deepseek.${model}`;
  const rows: Array<[string, string, number, number]> = [
    ["input_miss", "tokens", usage.input, pick(rates.inputMiss)],
    ["input_hit", "tokens", usage.cacheRead, pick(rates.inputHit)],
    ["output", "tokens", usage.output, pick(rates.output)],
  ];
  return rows.map(([kind, unit, quantity, rate]) => ({
    service: "llm",
    sku: `llm.${id}.${kind}`,
    unit,
    quantity,
    usd: perMillion(quantity, rate),
    precision: "exact",
    model: id,
  }));
}

/** The line that charges one Durable Object request. */
export function doRequestLine(count: number): Line {
  return {
    service: "durable_objects",
    sku: "durable_objects.requests",
    unit: "requests",
    quantity: count,
    usd: perMillion(count, PRICES.durableObjects.requestsPerMillion),
    precision: "measured",
  };
}

export function gbSecondsLine(gbSeconds: number, precision: Precision): Line {
  return {
    service: "durable_objects",
    sku: "durable_objects.duration",
    unit: "GB-s",
    quantity: gbSeconds,
    usd: perMillion(gbSeconds, PRICES.durableObjects.gbSecondsPerMillion),
    precision,
  };
}

export function sqlRowLines(rowsRead: number, rowsWritten: number): Line[] {
  return [
    {
      service: "durable_objects",
      sku: "durable_objects.rows_read",
      unit: "rows",
      quantity: rowsRead,
      usd: perMillion(rowsRead, PRICES.durableObjects.rowsReadPerMillion),
      precision: "measured",
    },
    {
      service: "durable_objects",
      sku: "durable_objects.rows_written",
      unit: "rows",
      quantity: rowsWritten,
      usd: perMillion(rowsWritten, PRICES.durableObjects.rowsWrittenPerMillion),
      precision: "measured",
    },
  ];
}

/** Storage is billed per GB-month; one sample of `bytes` held for `minutes` costs this much. */
export function storageLine(bytes: number, minutes: number): Line {
  const gbMinutes = (bytes / 1024 ** 3) * minutes;
  return {
    service: "storage",
    sku: "storage.sqlite",
    unit: "GB-min",
    quantity: gbMinutes,
    usd: (gbMinutes / (30 * 24 * 60)) * PRICES.durableObjects.storageGbMonth,
    precision: "measured",
  };
}

export function workersRequestLine(count: number): Line {
  return {
    service: "workers",
    sku: "workers.requests",
    unit: "requests",
    quantity: count,
    usd: perMillion(count, PRICES.workers.requestsPerMillion),
    precision: "measured",
  };
}

export function workersCpuLine(cpuMs: number): Line {
  return {
    service: "workers",
    sku: "workers.cpu_ms",
    unit: "ms",
    quantity: cpuMs,
    usd: perMillion(cpuMs, PRICES.workers.cpuMsPerMillion),
    precision: "estimated",
  };
}

export function dynamicWorkerLines(created: number, requests: number, cpuMs: number): Line[] {
  return [
    {
      service: "dynamic_workers",
      sku: "dynamic_workers.created",
      unit: "workers",
      quantity: created,
      usd: created * PRICES.dynamicWorkers.createdPerWorkerPerDay,
      precision: "measured",
    },
    {
      service: "dynamic_workers",
      sku: "dynamic_workers.requests",
      unit: "requests",
      quantity: requests,
      usd: perMillion(requests, PRICES.dynamicWorkers.requestsPerMillion),
      precision: "measured",
    },
    {
      service: "dynamic_workers",
      sku: "dynamic_workers.cpu_ms",
      unit: "ms",
      quantity: cpuMs,
      usd: perMillion(cpuMs, PRICES.dynamicWorkers.cpuMsPerMillion),
      precision: "estimated",
    },
  ];
}

export function secretsLine(count: number): Line {
  return {
    service: "secrets",
    sku: "secrets.count",
    unit: "secrets",
    quantity: count,
    usd: count * PRICES.secrets.perSecret,
    precision: "measured",
  };
}

/**
 * Active duration in a Durable Object is wall-clock time while at least one request is in flight, counted
 * once even when requests overlap. `enter`/`exit` bracket each request.
 */
export class ActiveTimer {
  private depth = 0;
  private since = 0;
  private accumulatedMs = 0;

  enter(nowMs: number): void {
    if (this.depth === 0) this.since = nowMs;
    this.depth += 1;
  }

  exit(nowMs: number): void {
    if (this.depth === 0) return;
    this.depth -= 1;
    if (this.depth === 0) this.accumulatedMs += Math.max(0, nowMs - this.since);
  }

  /** Milliseconds that have closed since the last call, plus the open interval up to `nowMs`. */
  drain(nowMs: number): number {
    let ms = this.accumulatedMs;
    this.accumulatedMs = 0;
    if (this.depth > 0) {
      ms += Math.max(0, nowMs - this.since);
      this.since = nowMs;
    }
    return ms;
  }

  get active(): boolean {
    return this.depth > 0;
  }
}

export const msToGbSeconds = (ms: number) => (ms / 1000) * PRICES.durableObjects.memoryGb;

/** UTC day key used for "unique Dynamic Workers per day". */
export const utcDay = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);
