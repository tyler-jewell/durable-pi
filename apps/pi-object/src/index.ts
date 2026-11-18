// The durable pi object: one PiAgent Durable Object per agent. It owns a Workspace (SQLite files plus a codemode
// `exec` backend), runs the pi-ai agent loop against DeepSeek, and meters every priced thing it does into a
// cost ledger. Derived from cloudflare/computer examples/pi-ai.
//
//   client ──► Worker ──► PiAgent DO ──► Workspace (files, exec = ECMAScript in a Dynamic Worker)
//                              ├──► DeepSeek (deepseek-flash)        key: DEEPSEEK_API_KEY, per request
//                              └──► cost ledger ──► GET /v1/cost, SSE /v1/cost/stream (every 10 s)

import { DurableObject } from "cloudflare:workers";

import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { deepseekModelAt } from "./tariff.js";
import * as M from "./cost/meter.js";
import { meterStorage } from "./cost/metered-storage.js";
import { CostStore, type Snapshot } from "./cost/store.js";

const MODEL_ID = "deepseek-flash";
/** Bound the spend if the model fails to converge. */
const MAX_TURNS = 10;
/** Secrets the Worker needs. Listed in the cost stream so their footprint is visible (they are not billed). */
const SECRETS_REQUIRED = ["DEEPSEEK_API_KEY", "DPI_TOKEN"] as const;
const PRUNE_EVERY_MS = 60 * 60_000;

const SYSTEM_PROMPT =
  "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did. " +
  "`exec` runs ECMAScript modules, not shell commands: put the work in `export default async function (input) {...}`.";

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export class PiAgent extends DurableObject<Env> {
  /** Rows read/written by SQLite since the last ledger flush. */
  private rows = { read: 0, written: 0 };
  private readonly storage = meterStorage(this.ctx.storage, (read, written) => {
    this.rows.read += read;
    this.rows.written += written;
  });
  private readonly cost = new CostStore(this.storage.sql);
  private readonly active = new M.ActiveTimer();
  private pending = { doRequests: 0, workersRequests: 0 };
  private lastStorageSampleMs = Date.now();
  private lastPruneMs = 0;

  workspace = new Workspace({
    storage: this.storage,
    backends: [new CodemodeBackend({ loader: this.env.LOADER })],
  });

  /** Run one DO entry point with metering: request count, active duration, and a ledger flush at the end. */
  private async tracked<T>(fn: () => Promise<T>): Promise<T> {
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

  /** Write everything metered since the last flush to the ledger. */
  private flush(atMs: number): void {
    const lines: M.Line[] = [];
    if (this.pending.doRequests) lines.push(M.doRequestLine(this.pending.doRequests));
    if (this.pending.workersRequests) lines.push(M.workersRequestLine(this.pending.workersRequests));
    const gbSeconds = M.msToGbSeconds(this.active.drain(atMs));
    if (gbSeconds > 0) lines.push(M.gbSecondsLine(gbSeconds, "measured"));
    if (this.rows.read || this.rows.written) lines.push(...M.sqlRowLines(this.rows.read, this.rows.written));
    const minutes = (atMs - this.lastStorageSampleMs) / 60_000;
    if (minutes > 0) {
      lines.push(M.storageLine(this.ctx.storage.sql.databaseSize, minutes));
      this.lastStorageSampleMs = atMs;
    }
    this.pending = { doRequests: 0, workersRequests: 0 };
    this.rows = { read: 0, written: 0 };
    this.cost.record(lines, atMs);
    if (atMs - this.lastPruneMs > PRUNE_EVERY_MS) {
      this.cost.prune(atMs);
      this.lastPruneMs = atMs;
    }
  }

  /** The Worker calls this for every routed request. Lets the shell in the Dynamic Worker reach this workspace. */
  async read(path: string): Promise<string> {
    return this.tracked(() => this.workspace.fs.readFile(path, "utf8"));
  }

  /** Live cost of this agent: lifetime totals by service, SKU, model and minute. Flushes first, so it is current. */
  async costSnapshot(): Promise<Snapshot> {
    return this.tracked(async () => {
      const now = Date.now();
      this.flush(now);
      return this.cost.snapshot(now, [M.secretsLine(SECRETS_REQUIRED.length)]);
    });
  }

  async run(task: string): Promise<{ answer: string; toolCalls: number; turns: number }> {
    return this.tracked(() => this.runLoop(task));
  }

  private async runLoop(task: string): Promise<{ answer: string; toolCalls: number; turns: number }> {
    const { tools, execute } = createPiTools({ workspace: this.workspace });

    const models = createModels();
    models.setProvider(deepseekProvider());

    const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
    // The key travels with each request as pi's per-request env; it is never stored in the DO.
    const env = { DEEPSEEK_API_KEY: this.env.DEEPSEEK_API_KEY };

    let toolCalls = 0;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      // The tariff in force now (peak or off-peak), priced by pi-ai; the same rule the host extension uses.
      const reply = await models.complete(deepseekModelAt(MODEL_ID, Date.now()), { systemPrompt: SYSTEM_PROMPT, messages, tools }, { env });
      messages.push(reply);
      this.cost.record(M.llmLines(MODEL_ID, reply.usage), Date.now());

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
        const lines: M.Line[] = [
          { service: "tools", sku: `tools.${call.name}`, unit: "calls", quantity: 1, usd: 0, precision: "measured" },
        ];
        if (call.name === "exec") {
          const source = String((call.arguments as { command?: unknown }).command ?? "");
          const created = this.cost.markDynamicWorker(M.utcDay(started), await sha256Hex(source)) ? 1 : 0;
          // Wall-clock time bounds the module's CPU time from above, so this line is an estimate.
          lines.push(...M.dynamicWorkerLines(created, 1, now - started));
        }
        this.cost.record(lines, now);

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json" } });

/** Server-Sent Events: a cost snapshot now, then one every 10 seconds until the client disconnects. */
function costStream(agent: DurableObjectStub<PiAgent>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async () => {
        if (closed) return;
        try {
          const snapshot = await agent.costSnapshot();
          controller.enqueue(encoder.encode(`event: cost\ndata: ${JSON.stringify(snapshot)}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`));
        }
      };
      await send();
      timer = setInterval(send, 10_000);
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
      return json(await agent.run(task));
    }

    return new Response(
      'POST {"task": "..."} to run; GET /file?path=/workspace/x; GET /v1/cost; GET /v1/cost/stream (SSE, 10 s)\n',
      { status: 405 },
    );
  },
} satisfies ExportedHandler<Env>;
