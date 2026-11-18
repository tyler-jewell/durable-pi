// The durable pi object: one PiAgent Durable Object per agent. It owns a Workspace (SQLite files plus a codemode
// `exec` backend), runs the pi-ai agent loop against DeepSeek, and records telemetry (tokens, tool calls, time).
// Cost is computed by cost objects from telemetry and provider balances, never from a rate table.
//
//   client ──► Worker ──► PiAgent DO ──► Workspace (files, exec = ECMAScript in a Dynamic Worker)
//                              ├──► DeepSeek (deepseek-flash)        key: DEEPSEEK_API_KEY, per request
//                              ├──► DeepSeek balance (≤ 1 per minute) ──► cost object "deepseek"
//                              └──► telemetry ──► GET /v1/cost, SSE /v1/cost/stream (every 60 s)
//
// Derived from cloudflare/computer examples/pi-ai.

import { DurableObject } from "cloudflare:workers";

import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { BUDGET, COST_CONFIG, COST_OBJECT_IDS, type CostObjectId } from "./cost/config.js";
import { budgetDecision, BudgetExceeded, type BudgetDecision } from "./cost/budget.js";
import { readDeepseekBalance } from "./cost/deepseek.js";
import { fetchRateCard, type BillingPeriod, type RateCard } from "./cost/cloudflare-rate-card.js";
import { cloudflareDoView, doPeriodUsage, type CloudflareDoView } from "./cost/cloudflare-do.js";
import { meterStorage } from "./cost/metered-storage.js";
import * as T from "./cost/meter.js";
import { deepseekView, type CostObjectView } from "./cost/objects.js";
import { dayOf, UsageStore, type UsageSnapshot } from "./cost/store.js";

const MODEL_ID = "deepseek-flash";
/** Bound the spend if the model fails to converge. */
const MAX_TURNS = 10;
/** Secrets the Worker needs. Listed in the cost stream so their footprint is visible (they are not billed). */
const SECRETS_REQUIRED = ["DEEPSEEK_API_KEY", "DPI_TOKEN"] as const;
const PRUNE_EVERY_MS = 60 * 60_000;
/** The balance is refreshed at most this often, however many clients are watching. */
const BALANCE_MAX_AGE_MS = 60_000;
/** The rate window: consumption between a reading now and one at least this long ago. */
const BURN_WINDOW_MS = 5 * 60_000;
/** The live cost stream pushes once a minute. */
const STREAM_EVERY_MS = 60_000;
/** The rate card changes rarely; it is re-read from the account at most this often, on demand (no scheduled job). */
const RATE_CARD_TTL_MS = 24 * 60 * 60_000;
const RATE_CARD_KEY = "rate-card";
/** The largest single model call seen so far: the most the next call can be expected to cost. */
const MAX_CALL_KEY = "max-call-usd";

const SYSTEM_PROMPT =
  "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did. " +
  "`exec` runs ECMAScript modules, not shell commands: put the work in `export default async function (input) {...}`.";

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export type RunResult = { answer: string; toolCalls: number; turns: number } | { budget: BudgetDecision };

export interface CostReport {
  asOf: number;
  /** One entry per cost object. Each has its own free-tier toggle (off by default). */
  objects: Array<CostObjectView | CloudflareDoView>;
  /** The per-DO budget guard: whether new work is allowed, and what is left. */
  budget: BudgetDecision;
  /** Telemetry: exact counts and durations from pi and from this app's clock. */
  usage: UsageSnapshot;
}

export class PiAgent extends DurableObject<Env> {
  /** Rows read/written by SQLite since the last flush. */
  private rows = { read: 0, written: 0 };
  private readonly storage = meterStorage(this.ctx.storage, (read, written) => {
    this.rows.read += read;
    this.rows.written += written;
  });
  private readonly usage = new UsageStore(this.storage.sql);
  private readonly active = new T.ActiveTimer();
  private pending = { doRequests: 0, workersRequests: 0 };
  private lastStorageSampleMs = Date.now();
  private lastPruneMs = 0;

  workspace = new Workspace({
    storage: this.storage,
    backends: [new CodemodeBackend({ loader: this.env.LOADER })],
  });

  /** Run one DO entry point with metering: request count, active duration, and a telemetry flush at the end. */
  private async tracked<R>(fn: () => Promise<R>): Promise<R> {
    this.active.enter(Date.now());
    this.pending.doRequests += 1;
    this.pending.workersRequests += 1;
    try {
      return await fn();
    } finally {
      this.active.exit(Date.now());
      this.flush(Date.now());
    }
  }

  /** Write everything metered since the last flush to the telemetry store. */
  private flush(atMs: number): void {
    const lines: T.Line[] = [];
    if (this.pending.doRequests) lines.push(T.doRequestLine(this.pending.doRequests));
    if (this.pending.workersRequests) lines.push(T.workersRequestLine(this.pending.workersRequests));
    const activeMs = this.active.drain(atMs);
    if (activeMs > 0) lines.push(T.doDurationLine(activeMs));
    if (this.rows.read || this.rows.written) lines.push(...T.sqlRowLines(this.rows.read, this.rows.written));
    const minutes = (atMs - this.lastStorageSampleMs) / 60_000;
    if (minutes > 0) {
      lines.push(T.storageLine(this.ctx.storage.sql.databaseSize, minutes));
      this.lastStorageSampleMs = atMs;
    }
    this.pending = { doRequests: 0, workersRequests: 0 };
    this.rows = { read: 0, written: 0 };
    this.usage.record(lines);
    if (atMs - this.lastPruneMs > PRUNE_EVERY_MS) {
      this.usage.prune(atMs);
      this.lastPruneMs = atMs;
    }
  }

  /** The Worker calls this for every routed request. Lets the shell in the Dynamic Worker reach this workspace. */
  async read(path: string): Promise<string> {
    return this.tracked(() => this.workspace.fs.readFile(path, "utf8"));
  }

  /** Live cost and telemetry. The balance is re-read only if the last reading is over a minute old. */
  async costSnapshot(): Promise<CostReport> {
    return this.tracked(async () => {
      const now = Date.now();
      this.flush(now);
      const deepseek = await this.deepseekObject(now);
      const { cloudflare, decision } = await this.budgetState(now);
      return {
        asOf: now,
        objects: [deepseek, cloudflare],
        budget: decision,
        usage: this.usage.snapshot([T.secretsLine(SECRETS_REQUIRED.length)]),
      };
    });
  }

  /** Turn one cost object's free-tier toggle on or off. Off is the default. */
  async setFreeTier(id: CostObjectId, enabled: boolean): Promise<{ id: CostObjectId; freeTier: boolean }> {
    return this.tracked(async () => {
      await this.ctx.storage.put(freeTierKey(id), enabled);
      return { id, freeTier: enabled };
    });
  }

  /** Runs a task. Refused by the budget guard, it returns the decision instead of starting any work. */
  async run(task: string): Promise<RunResult> {
    return this.tracked(async () => {
      try {
        return await this.runLoop(task);
      } catch (error) {
        if (error instanceof BudgetExceeded) return { budget: error.decision };
        throw error;
      }
    });
  }

  /** Cloudflare, LLM and the largest call, against the cap. Read fresh each time: spend moves between calls. */
  private async budgetState(now: number): Promise<{ cloudflare: CloudflareDoView; decision: BudgetDecision }> {
    const cloudflare = await this.cloudflareObject(now);
    const fromDay = cloudflare.period ? dayOf(Date.parse(cloudflare.period.start)) : dayOf(now);
    const llmUsd = this.usage
      .dailyRows(fromDay, dayOf(now))
      .filter((r) => r.sku.startsWith("llm.") && r.sku.endsWith(".estimate"))
      .reduce((sum, r) => sum + r.quantity, 0);
    const maxCallUsd = (await this.ctx.storage.get<number>(MAX_CALL_KEY)) ?? 0;
    const decision = budgetDecision({
      capUsd: BUDGET.perDoUsdPerPeriod,
      cloudflareUsd: cloudflare.actualUsd,
      llmUsd,
      maxCallUsd,
    });
    return { cloudflare, decision };
  }

  private async assertBudget(): Promise<void> {
    const { decision } = await this.budgetState(Date.now());
    if (!decision.allowed) throw new BudgetExceeded(decision);
  }

  private async deepseekObject(now: number): Promise<CostObjectView> {
    const cfg = COST_CONFIG.deepseek;
    const freeTier = (await this.ctx.storage.get<boolean>(freeTierKey("deepseek"))) === true;

    let note: string | undefined;
    let latest = this.usage.latestBalance();
    if (!latest || now - latest.at >= BALANCE_MAX_AGE_MS) {
      try {
        const fresh = await readDeepseekBalance(this.env.DEEPSEEK_API_KEY, fetch, now);
        this.usage.recordBalance(fresh);
        latest = fresh;
      } catch (error) {
        // Keep the last good reading, and say that it is stale.
        note = `balance refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const prior = latest ? this.usage.balanceAtOrBefore(latest.at - BURN_WINDOW_MS) : null;
    return deepseekView({ id: "deepseek", label: cfg.label, config: cfg, balance: latest, prior, freeTier, note });
  }

  /** Cloudflare Durable Object cost: this period's telemetry at the account's rate card. */
  private async cloudflareObject(now: number): Promise<CloudflareDoView> {
    const freeTier = (await this.ctx.storage.get<boolean>(freeTierKey("cloudflare-do"))) === true;
    const cached = await this.ctx.storage.get<{ fetchedAt: number; card: RateCard; period: BillingPeriod }>(RATE_CARD_KEY);
    let card: RateCard | null = cached?.card ?? null;
    let period: BillingPeriod | null = cached?.period ?? null;
    let note: string | undefined;
    if (!this.env.CLOUDFLARE_API_TOKEN || !this.env.CLOUDFLARE_ACCOUNT_ID) {
      note = "set the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets (billing read)";
    } else if (!cached || !cached.period || now - cached.fetchedAt >= RATE_CARD_TTL_MS) {
      // An entry cached before periods were stored has no period: re-read it, so allowances are not priced over one day.
      try {
        const fetched = await fetchRateCard(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
        card = fetched.card;
        period = fetched.period;
        await this.ctx.storage.put(RATE_CARD_KEY, { fetchedAt: now, card, period });
      } catch (error) {
        note = `rate card refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // Priced over the billing period: from the subscription's period start, through today.
    const fromDay = period ? dayOf(Date.parse(period.start)) : dayOf(now);
    const usage = doPeriodUsage(this.usage.dailyRows(fromDay, dayOf(now)), fromDay, dayOf(now));
    return cloudflareDoView({ card, period, usage, freeTier, asOf: now, note });
  }

  private llmModel() {
    const model = deepseekProvider().getModels().find((m) => m.id === MODEL_ID);
    if (!model) throw new Error(`pi-ai has no DeepSeek model ${MODEL_ID}`);
    return model;
  }

  private async runLoop(task: string): Promise<RunResult> {
    const { tools, execute } = createPiTools({ workspace: this.workspace });

    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = this.llmModel();

    const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
    // The key travels with each request as pi's per-request env; it is never stored in the DO.
    const env = { DEEPSEEK_API_KEY: this.env.DEEPSEEK_API_KEY };

    let toolCalls = 0;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      await this.assertBudget();
      const callStarted = Date.now();
      const reply = await models.complete(model, { systemPrompt: SYSTEM_PROMPT, messages, tools }, { env });
      const callEnded = Date.now();
      messages.push(reply);
      this.usage.record([...T.llmLines(MODEL_ID, reply.usage), T.llmWallLine(MODEL_ID, callEnded - callStarted)]);

      // Track the largest call: the budget guard uses it as the expected cost of the next one.
    const callUsd = reply.usage.cost.total;
    if (callUsd > ((await this.ctx.storage.get<number>(MAX_CALL_KEY)) ?? 0)) await this.ctx.storage.put(MAX_CALL_KEY, callUsd);

    const calls = reply.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) {
        const answer = reply.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        return { answer, toolCalls, turns: turn + 1 };
      }

      for (const call of calls) {
        toolCalls += 1;
        const started = Date.now();
        const { content, isError } = await execute(call);
        const now = Date.now();
        const lines: T.Line[] = T.toolLines(call.name, now - started);
        if (call.name === "exec") {
          const source = String((call.arguments as { command?: unknown }).command ?? "");
          const created = this.usage.markDynamicWorker(T.utcDay(started), await sha256Hex(source)) ? 1 : 0;
          // Wall-clock time bounds the module's CPU time from above.
          lines.push(...T.dynamicWorkerLines(created, 1, now - started));
        }
        this.usage.record(lines);

        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError,
          timestamp: Date.now(),
        });
      }
    }

    return { answer: `Gave up after ${MAX_TURNS} turns.`, toolCalls, turns: MAX_TURNS };
  }
}

const freeTierKey = (id: string) => `free-tier:${id}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json" } });

/** Server-Sent Events: a cost report now, then one every minute until the client disconnects. */
function costStream(agent: DurableObjectStub<PiAgent>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async () => {
        if (closed) return;
        try {
          const report = await agent.costSnapshot();
          controller.enqueue(encoder.encode(`event: cost\ndata: ${JSON.stringify(report)}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`));
        }
      };
      await send();
      timer = setInterval(send, STREAM_EVERY_MS);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed: every route needs the device token, so a public URL cannot spend the model key.
    if (!env.DPI_TOKEN) return new Response("DPI_TOKEN is not set\n", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${env.DPI_TOKEN}`) {
      return new Response("unauthorized\n", { status: 401 });
    }

    const url = new URL(request.url);
    // One agent per name; the demo uses a single agent. Use ?agent=<name> to address another.
    const agent = env.PiAgent.get(env.PiAgent.idFromName(url.searchParams.get("agent") ?? "demo"));

    if (request.method === "GET" && url.pathname === "/v1/cost") return json(await agent.costSnapshot());
    if (request.method === "GET" && url.pathname === "/v1/cost/stream") return costStream(agent);

    const toggle = url.pathname.match(/^\/v1\/cost\/objects\/([a-z-]+)\/free-tier$/);
    if (request.method === "POST" && toggle) {
      const id = toggle[1] as CostObjectId;
      if (!(COST_OBJECT_IDS as readonly string[]).includes(id)) return new Response("no such cost object\n", { status: 404 });
      const { enabled } = (await request.json()) as { enabled?: unknown };
      if (typeof enabled !== "boolean") return new Response("body needs {\"enabled\": true|false}\n", { status: 400 });
      return json(await agent.setFreeTier(id, enabled));
    }

    if (request.method === "GET" && url.pathname === "/file") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("path is required\n", { status: 400 });
      try {
        return new Response(await agent.read(path));
      } catch {
        return new Response("not found\n", { status: 404 });
      }
    }

    if (request.method === "POST" && url.pathname === "/") {
      const { task } = (await request.json()) as { task?: string };
      if (!task) return new Response("body needs a task\n", { status: 400 });
      const result = await agent.run(task);
      return json(result, "budget" in result ? 402 : 200);
    }

    return new Response(
      'POST {"task": "..."} to run; GET /file?path=/workspace/x; GET /v1/cost; GET /v1/cost/stream (SSE, 60 s); ' +
        'POST /v1/cost/objects/<id>/free-tier {"enabled": bool}\n',
      { status: 405 },
    );
  },
} satisfies ExportedHandler<Env>;
