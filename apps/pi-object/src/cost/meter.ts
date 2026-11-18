// Telemetry: exact counts and durations, with no price attached. Pi supplies the token counts and this app supplies the
// tool calls and clock readings. Cost objects (objects.ts) turn these quantities into dollars, so a rate or a
// balance rule can change without rewriting what was measured.
//
// "pi" lines are copied from pi's own usage record. "measured" lines are counted or timed here.

import type { Usage as PiUsage } from "@earendil-works/pi-ai";

export type Source = "pi" | "measured";

export type Service = "llm" | "tools" | "durable_objects" | "workers" | "dynamic_workers" | "storage" | "secrets";

export interface Line {
  service: Service;
  /** Stable key: service.resource.unit, e.g. "llm.deepseek-flash.output". */
  sku: string;
  unit: string;
  quantity: number;
  source: Source;
  /** Set for LLM lines, so totals can be broken down by model. */
  model?: string;
}

/**
 * Token counts exactly as pi reports them for one assistant message. `output` already includes reasoning tokens;
 * `output_reasoning` is the part of it that was reasoning, reported for information and never added again.
 * `estimate` is pi's own cost figure from its catalog. It is an estimate, not a bill, and nothing bills from it.
 */
export function llmLines(modelId: string, usage: PiUsage): Line[] {
  const base = `llm.${modelId}`;
  const row = (kind: string, unit: string, quantity: number): Line => ({
    service: "llm", sku: `${base}.${kind}`, unit, quantity, source: "pi", model: modelId,
  });
  const reasoning = (usage as { reasoning?: number }).reasoning ?? 0;
  return [
    row("input_miss", "tokens", usage.input),
    row("input_hit", "tokens", usage.cacheRead),
    row("cache_write", "tokens", usage.cacheWrite),
    row("output", "tokens", usage.output),
    row("output_reasoning", "tokens", reasoning),
    row("estimate", "usd", usage.cost.total),
  ];
}

/** Wall-clock time of one model call, measured here around `models.complete`. */
export function llmWallLine(modelId: string, ms: number): Line {
  return { service: "llm", sku: `llm.${modelId}.wall_ms`, unit: "ms", quantity: ms, source: "measured", model: modelId };
}

/** One tool call and its wall-clock time. */
export function toolLines(name: string, ms: number): Line[] {
  return [
    { service: "tools", sku: `tools.${name}.calls`, unit: "calls", quantity: 1, source: "measured" },
    { service: "tools", sku: `tools.${name}.wall_ms`, unit: "ms", quantity: ms, source: "measured" },
  ];
}

export function doRequestLine(count: number): Line {
  return { service: "durable_objects", sku: "durable_objects.requests", unit: "requests", quantity: count, source: "measured" };
}

/** Active duration: wall-clock ms while at least one request is in flight (see ActiveTimer). */
export function doDurationLine(ms: number): Line {
  return { service: "durable_objects", sku: "durable_objects.duration", unit: "ms", quantity: ms, source: "measured" };
}

export function sqlRowLines(rowsRead: number, rowsWritten: number): Line[] {
  return [
    { service: "durable_objects", sku: "durable_objects.rows_read", unit: "rows", quantity: rowsRead, source: "measured" },
    { service: "durable_objects", sku: "durable_objects.rows_written", unit: "rows", quantity: rowsWritten, source: "measured" },
  ];
}

/** Storage as byte-minutes: `bytes` held for `minutes`. Converts to GB-months in the cost object. */
export function storageLine(bytes: number, minutes: number): Line {
  return { service: "storage", sku: "storage.sqlite", unit: "byte-min", quantity: bytes * minutes, source: "measured" };
}

export function workersRequestLine(count: number): Line {
  return { service: "workers", sku: "workers.requests", unit: "requests", quantity: count, source: "measured" };
}

/** Dynamic Workers: created (once per unique code per UTC day), requests, and wall-clock ms as a CPU upper bound. */
export function dynamicWorkerLines(created: number, requests: number, wallMs: number): Line[] {
  return [
    { service: "dynamic_workers", sku: "dynamic_workers.created", unit: "workers", quantity: created, source: "measured" },
    { service: "dynamic_workers", sku: "dynamic_workers.requests", unit: "requests", quantity: requests, source: "measured" },
    { service: "dynamic_workers", sku: "dynamic_workers.wall_ms", unit: "ms", quantity: wallMs, source: "measured" },
  ];
}

/** Live footprint, shown in the snapshot and never stored. */
export function secretsLine(count: number): Line {
  return { service: "secrets", sku: "secrets.count", unit: "secrets", quantity: count, source: "measured" };
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
}

/** UTC day key used for "unique Dynamic Workers per day". */
export const utcDay = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);
