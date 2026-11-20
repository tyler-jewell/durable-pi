// The mesh model provider: pi's agents call the enabled chat tools of the dpi-mcp server. A call is an `ask_model`
// call with the model's id as its required tag, so the server picks among the enabled tools that carry it (A/B by
// default) and applies its context budget, output limit and meter. Tool calls travel both ways in OpenAI form.
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { callMesh, meshEndpoint } from "./mesh.js";

const API = "mesh-mcp";
const PROVIDER = "mesh";

/** The model id is the tag a mesh tool must carry. `chat` is the kind tag every enabled chat tool has. */
export const MESH_MODELS = [{ id: "chat", name: "Mesh chat (A/B over enabled chat tools)" }] as const;

/** A conservative window for budgeting in pi. The MCP server enforces each tool's real served window. */
const CONTEXT_WINDOW = 16_384;
const MAX_OUTPUT = 2_048;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } });

/** OpenAI wire message, as `ask_model` takes it. */
interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

const textOf = (content: unknown, where: string): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      // Mesh chat tools are text-only. Refusing is better than silently dropping the image.
      throw Error(`${where} has ${block.type} content; mesh chat tools accept text only`);
    })
    .join("");
};

/** The pi transcript as OpenAI messages and the tool declarations the model may call. */
export function toWire(context: TranscriptContext): { messages: WireMessage[]; tools: { name: string; description: string; parameters: Record<string, unknown> }[] } {
  const messages: WireMessage[] = [];
  const system = getCurrentSystemPrompt(context.messages);
  if (system) messages.push({ role: "system", content: system });
  for (const m of context.messages) {
    if (m.role === "system") continue; // Folded into the current prompt above.
    if (m.role === "user") {
      messages.push({ role: "user", content: textOf(m.content, "user message") });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b): b is ToolCall => b.type === "toolCall");
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      });
    } else {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, name: m.toolName, content: textOf(m.content, "tool result") });
    }
  }
  const tools = getCurrentTools(context.messages).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }));
  return { messages, tools };
}

interface ChatAnswer {
  tool: string;
  model: string;
  text: string;
  inToks: number;
  outToks: number;
  truncated: boolean;
  toolCalls: { id: string; name: string; arguments: string }[];
}

/** One model turn: stream the answer as pi events, then the final message. Errors end the stream, never throw. */
function streamTurn(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const out: AssistantMessage = {
    role: "assistant",
    content: [],
    api: API,
    provider: PROVIDER,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(async () => {
    stream.push({ type: "start", partial: out });
    try {
      if (!meshEndpoint()) throw Error("Mesh models require DPI_MCP_URL and DPI_MCP_TOKEN");
      const { messages, tools } = toWire(context);
      const result = await callMesh(
        "ask_model",
        {
          kind: "llm",
          // A turn that offers tools needs a chat tool that passed probe_tool_use; a plain turn needs only a chat tool.
          requires: tools.length ? [model.id, "tool-use"] : [model.id],
          messages,
          ...(tools.length ? { tools, tool_choice: "auto" } : {}),
        },
        { signal: options?.signal, timeoutMs: 300_000 },
      );
      if (result.isError) throw Error(result.text || "The mesh model returned an error");
      const answer = result.structured as ChatAnswer | undefined;
      if (!answer || typeof answer.text !== "string" || !Array.isArray(answer.toolCalls)) throw Error("The mesh model returned an invalid answer");
      out.responseModel = answer.model;
      out.usage = {
        input: answer.inToks,
        output: answer.outToks,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: answer.inToks + answer.outToks,
        cost: { ...ZERO_COST },
      };

      if (answer.text) {
        out.content.push({ type: "text", text: "" });
        const index = out.content.length - 1;
        stream.push({ type: "text_start", contentIndex: index, partial: out });
        (out.content[index] as TextContent).text = answer.text;
        stream.push({ type: "text_delta", contentIndex: index, delta: answer.text, partial: out });
        stream.push({ type: "text_end", contentIndex: index, content: answer.text, partial: out });
      }
      for (const call of answer.toolCalls) {
        let args: JsonObject;
        try {
          args = JSON.parse(call.arguments || "{}") as JsonObject;
        } catch {
          throw Error(`The mesh model wrote arguments for ${call.name} that are not JSON`);
        }
        const block: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: args };
        out.content.push(block);
        const index = out.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex: index, partial: out });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: call.arguments, partial: out });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: out });
      }

      // A cut-off answer is reported as cut off, and its tool calls were withheld by the server.
      out.stopReason = answer.truncated ? "length" : answer.toolCalls.length ? "toolUse" : "stop";
      stream.push({ type: "done", reason: out.stopReason, message: out });
      stream.end(out);
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      out.stopReason = aborted ? "aborted" : "error";
      out.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: out.stopReason, error: out });
      stream.end(out);
    }
  });
  return stream;
}

/** The provider the backend registers when DPI_PROVIDER=mesh. Its key is the MCP token; the endpoint is DPI_MCP_URL. */
export function meshProvider(): Provider {
  const endpoint = meshEndpoint();
  const baseUrl = endpoint?.url.origin ?? "";
  const models = MESH_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    api: API,
    provider: PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { ...ZERO_COST },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT,
  }));
  const streams = {
    stream: (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => streamTurn(model, context, options),
    streamSimple: (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => streamTurn(model, context, options),
  };
  return createProvider({
    id: PROVIDER,
    name: "Mesh (dpi-mcp)",
    baseUrl,
    auth: {
      apiKey: {
        name: "DPI_MCP_TOKEN",
        resolve: async () => {
          const token = process.env.DPI_MCP_TOKEN;
          return token && token.trim() ? { auth: { apiKey: token }, source: "DPI_MCP_TOKEN" } : undefined;
        },
      },
    },
    models,
    api: streams,
  });
}
