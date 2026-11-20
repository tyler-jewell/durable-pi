// Every model is an MCP tool. An enabled model in the tool store is registered on each live server as a tool of
// its own name, and a disabled one is removed from the list. `ask_model` is the one router: it picks among the
// enabled tools of a kind by the tags it requires, at random (A/B), and calls the one it picked.
//
// Every call goes through one path: the context budget, the output cap, the truncation flag, the meter, and the
// store's last-used time.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tokenCostUsd } from "./cloud-catalog.js";
import { loadMeter, recordUsage } from "./meter.js";
import { runDecision, runLlm, type DecisionQuestion, type LlmResult, type DecisionResult } from "./models.js";
import { loadStore, saveStore, select, type ModelTool, type ToolStore } from "./tool-store.js";

const ROLE = z.enum(["system", "user", "assistant"]);
const MessagesShape = { messages: z.array(z.object({ role: ROLE, content: z.string() })).min(1).describe("the conversation, in order") };
const DecisionShape = {
  state: z.record(z.string(), z.unknown()).describe("the JSON state to judge"),
  questions: z.record(z.string(), z.unknown()).describe("typed questions: { name: { type: 'noul' | 'choice', instructions, criteria? } }"),
};

/** The key a tool's transport needs, from its environment variable. Never stored. */
function keyOf(tool: ModelTool): string | undefined {
  return tool.secretEnv ? process.env[tool.secretEnv] : undefined;
}

/** Record one call in the meter and the store. Cloud spend is the catalog price times the tokens. */
function account(store: ToolStore, tool: ModelTool, kind: ModelTool["kind"], ms: number, inToks: number, outToks: number) {
  const now = Date.now();
  const costUsd = tool.transport === "cloudflare-workers-ai" ? (tokenCostUsd(tool.pricing, inToks, outToks) ?? 0) : 0;
  recordUsage(loadMeter(), { startedAt: now - ms, endedAt: now, model: tool.family, kind, transport: tool.transport, inToks, outToks, costUsd });
  tool.lastUsedAt = now;
  saveStore(store);
}

/** Call an enabled chat tool. Returns the answer with its budget facts, and never a silent cut. */
export async function callChat(store: ToolStore, tool: ModelTool, messages: { role: "system" | "user" | "assistant"; content: string }[]): Promise<LlmResult> {
  const t0 = Date.now();
  const r = await runLlm(tool.address, tool.model, messages, { transport: tool.transport, apiKey: keyOf(tool), contextWindow: tool.servedContext });
  account(store, tool, "llm", Date.now() - t0, r.inToks, r.outToks);
  return r;
}

/** Call an enabled decision tool. */
export async function callDecision(store: ToolStore, tool: ModelTool, state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecisionResult> {
  const t0 = Date.now();
  const r = await runDecision(tool.address, tool.model, state, questions, { transport: tool.transport, apiKey: keyOf(tool), contextWindow: tool.servedContext });
  account(store, tool, "decision", Date.now() - t0, r.inToks, r.outToks);
  return r;
}

/** The result a chat call returns to an MCP client. A cut-off answer says so in the text itself. */
export function chatResult(tool: ModelTool, r: LlmResult) {
  const notice = r.truncated ? "\n\n[truncated: the answer hit the output limit and is incomplete]" : "";
  return {
    content: [{ type: "text" as const, text: r.text + notice }],
    structuredContent: {
      tool: tool.name,
      model: tool.model,
      text: r.text,
      inToks: r.inToks,
      outToks: r.outToks,
      finishReason: r.finishReason,
      truncated: r.truncated,
      maxTokens: r.maxTokens,
      guarded: r.guarded,
      servedContext: tool.servedContext ?? null,
    },
  };
}

export function decisionResult(tool: ModelTool, r: DecisionResult) {
  const body = { tool: tool.name, model: tool.model, answers: r.answers, inToks: r.inToks, outToks: r.outToks, guarded: r.guarded };
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

function toolDescription(t: ModelTool): string {
  const tags = t.tags.length ? ` Tags: ${t.tags.join(", ")}.` : "";
  const ctx = t.servedContext ? ` Served window: ${t.servedContext} tokens.` : " Served window unknown: calls are unguarded.";
  const price = t.pricing ? ` Priced per million tokens (in ${t.pricing.inPerM}, out ${t.pricing.outPerM}).` : "";
  return `${t.description}.${tags}${ctx}${price} Source: ${t.source}, host ${t.host}, model ${t.model}.`;
}

/** Keeps every live server's tool list in step with the store. */
export class ModelTools {
  private servers = new Map<McpServer, Map<string, RegisteredTool>>();

  constructor(private readonly load: () => ToolStore = loadStore) {}

  /** Register the router and every model tool on a new server. */
  attach(server: McpServer): void {
    this.servers.set(server, new Map());
    this.registerRouter(server);
    this.sync(server);
  }

  detach(server: McpServer): void {
    this.servers.delete(server);
  }

  /** Make the given server (or every server) match the store. Idempotent. */
  sync(only?: McpServer): void {
    const store = this.load();
    for (const [server, handles] of this.servers) {
      if (only && server !== only) continue;
      const wanted = new Set(store.tools.map((t) => t.name));
      for (const [name, handle] of handles) {
        if (!wanted.has(name)) {
          handle.remove();
          handles.delete(name);
        }
      }
      for (const tool of store.tools) {
        let handle = handles.get(tool.name);
        if (!handle) {
          handle = this.registerModel(server, tool);
          handles.set(tool.name, handle);
        } else {
          // Keep the description in step with the store; a changed name is a different tool, handled above.
          handle.update({ description: toolDescription(tool) });
        }
        if (tool.enabled) handle.enable();
        else handle.disable();
      }
    }
  }

  private registerModel(server: McpServer, tool: ModelTool): RegisteredTool {
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: tool.source === "cloud" };
    if (tool.kind === "decision") {
      return server.registerTool(tool.name, { title: `Decision model: ${tool.model}`, description: toolDescription(tool), inputSchema: DecisionShape, annotations }, async (args) => {
        const store = this.load();
        const current = store.tools.find((t) => t.name === tool.name);
        if (!current?.enabled) throw new Error(`${tool.name} is disabled`);
        const r = await callDecision(store, current, args.state, args.questions as Record<string, DecisionQuestion>);
        return decisionResult(current, r);
      });
    }
    return server.registerTool(tool.name, { title: `Chat model: ${tool.model}`, description: toolDescription(tool), inputSchema: MessagesShape, annotations }, async (args) => {
      const store = this.load();
      const current = store.tools.find((t) => t.name === tool.name);
      if (!current?.enabled) throw new Error(`${tool.name} is disabled`);
      const r = await callChat(store, current, args.messages);
      return chatResult(current, r);
    });
  }

  private registerRouter(server: McpServer): void {
    server.registerTool(
      "ask_model",
      {
        title: "Ask a model: one router for every enabled tool of a kind",
        description:
          "Pick one enabled model tool of the kind, at random (A/B), after filtering by the tags you require, then call it. Use `llm` with messages, or `decision` with state and questions. Pass `name` to call one tool by name instead. Pass `requires` to narrow the pool (every tag must match).",
        inputSchema: {
          kind: z.enum(["llm", "decision"]),
          name: z.string().optional().describe("a tool name, to call that tool deterministically"),
          requires: z.array(z.string()).optional().describe("tags every candidate must have"),
          prefer: z.enum(["mesh", "cloud"]).optional().describe("when the mode is auto, which side to try first"),
          messages: MessagesShape.messages.optional(),
          state: DecisionShape.state.optional(),
          questions: DecisionShape.questions.optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        const store = this.load();
        const tool = select(store, args.kind, { name: args.name, requires: args.requires, prefer: args.prefer });
        if (args.kind === "llm") {
          if (!args.messages) throw new Error("ask_model kind=llm needs messages");
          return chatResult(tool, await callChat(store, tool, args.messages));
        }
        if (!args.state || !args.questions) throw new Error("ask_model kind=decision needs state and questions");
        return decisionResult(tool, await callDecision(store, tool, args.state, args.questions as Record<string, DecisionQuestion>));
      },
    );
  }
}
