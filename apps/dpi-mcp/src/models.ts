// The model transport: how this system finds a model and calls it. Discovery (probeHost), the Access headers
// every mesh call carries (meshFetch), the context budget (context.ts), and the two calls (runLlm, runDecision).
// Nothing here stores anything. Which models are enabled, and the MCP tools they become, live in tool-store.ts
// and model-tools.ts.
import { accessHeadersFor } from "./mesh-config.js";
import { budget, estimateTokens, MIN_OUTPUT_TOKENS, servedContextOf, type Budget } from "./context.js";

export type ModelKind = "llm" | "decision";
export type Transport = "openai-compat" | "cloudflare-workers-ai";

export interface ModelInfo {
  id: string;
  kind: ModelKind; // `text` → llm, `decisions` → decision (from output_modalities)
  aliases: string[];
  /** The window the server runs with. The budget uses this. Undefined when the host does not say. */
  servedContext?: number;
  /** The window the model was trained for. Informational; never used for the budget. */
  trainedContext?: number;
}

export interface HostProbe {
  host: string;
  /** Canonical endpoint on the mesh, e.g. `https://<host>.<your-zone>` (Cloudflare Tunnel + Access). */
  address: string;
  /** SSH target for config/launch-agent inspection, e.g. `studio` (from ~/.ssh/config). */
  ssh?: string;
  health: "online" | "offline" | "unknown";
  reachable: boolean; // whether `address` answered the probe
  models: ModelInfo[];
  discoveredAt: number;
  /** Config + launchd auto-start state, filled by inspect_host. */
  config?: { processes: { pid: number; ppid: number; command: string }[]; autoStartServices: string[] };
  /** A live decision/chat test result, filled by inspect_host. */
  test?: { health: string; kind: "llm" | "decision"; ms: number; sample?: string };
  error?: string;
}

/** The canonical model family. It strips the quantization/format suffix and the cloud namespace, so a
 *  local GGUF and its cloud twin share one family: a quantized local file and its
 *  catalog name map to the same family key. Cost comparisons pair twins by this key. */
export function familyOf(model: string): string {
  const base = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return base
    .replace(/-(UD-)?(Q|IQ|MXFP|BF16|F16|F32|FP8)[0-9_]*(_K(_[MSXL])?|_0)?$/i, "")
    .replace(/-instruct(-\d+)?$/i, "")
    .toLowerCase();
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** A short-lived fetch; returns the response or undefined on network failure. */
/** The one fetch every model call uses. Mesh URLs (Cloudflare Tunnel + Access) get their service-token
 *  headers here, so no caller can forget them; local and cloud URLs are passed through unchanged. */
export function meshFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...accessHeadersFor(url), ...((init.headers as Record<string, string> | undefined) ?? {}) };
  return fetch(url, { ...init, headers });
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response | undefined> {
  try {
    return await meshFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch {
    return undefined;
  }
}

/**
 * Probe a host's HTTP base and derive its capabilities. llama.cpp 1.0.0 answers `/health`
 * and `/v1/models` (each model lists `architecture.output_modalities`: `text` or `decisions`);
 * a host that exposes `/v1/systemone` answers System One decision questions.
 */
export async function probeHost(host: string, address: string, timeoutMs = 5000, headers?: Record<string, string>): Promise<HostProbe> {
  const base = address.replace(/\/+$/, "");
  const cap: HostProbe = { host, address: base, health: "offline", reachable: false, models: [], discoveredAt: Date.now() };
  const health = await fetchJson(`${base}/health`, { method: "GET", headers }, timeoutMs);
  if (health && (health.status === 401 || health.status === 403)) {
    // Cloudflare Access (or the host's own auth) refused the request: say so, not "no model server".
    cap.error = `access denied (HTTP ${health.status}) at ${address}: the host's Access service token is missing or wrong`;
    return cap;
  }
  if (health?.ok) {
    const body = (await health.json().catch(() => undefined)) as { status?: string } | undefined;
    cap.health = body?.status === "ok" ? "online" : "offline";
  }
  cap.reachable = cap.health === "online";
  if (!cap.reachable) {
    cap.error = `${address} did not answer /health (the model server may bind 127.0.0.1 only; widen it or expose it through a Cloudflare Tunnel)`;
    return cap;
  }
  const list = await fetchJson(`${base}/v1/models`, { method: "GET", headers }, timeoutMs);
  if (list?.ok) {
    const data = (await list.json()) as { data?: { id?: string; aliases?: string[]; architecture?: { output_modalities?: string[] }; context_length?: number; status?: { args?: unknown; preset?: unknown } }[] };
    for (const m of data.data ?? []) {
      if (!m.id) continue;
      const modalities = m.architecture?.output_modalities ?? [];
      cap.models.push({
        id: m.id,
        kind: modalities.includes("decisions") ? "decision" : "llm",
        aliases: m.aliases ?? [],
        servedContext: servedContextOf(m),
        trainedContext: typeof m.context_length === "number" ? m.context_length : undefined,
      });
    }
    // A single plain server has no status block. Its window is the one /props reports for the running slot.
    if (cap.models.length === 1 && cap.models[0].servedContext === undefined) {
      const props = await fetchJson(`${base}/props`, { method: "GET", headers }, timeoutMs);
      const n = props?.ok ? ((await props.json().catch(() => undefined)) as { default_generation_settings?: { n_ctx?: number } } | undefined)?.default_generation_settings?.n_ctx : undefined;
      if (typeof n === "number" && n > 0) cap.models[0].servedContext = n;
    }
  }
  return cap;
}

/** Chat completion against an LLM endpoint. Returns the assistant's text. */
export interface LlmResult {
  text: string;
  inToks: number;
  outToks: number;
  /** The provider's stop reason. `length` means the answer hit the output cap and is cut off. */
  finishReason: "stop" | "length" | "tool_calls" | "other";
  /** True when the answer was cut off by the output cap. A truncated answer is never presented as complete. */
  truncated: boolean;
  /** Tool calls the model asked for. Empty when the answer was cut off: a truncated call is never offered as complete. */
  toolCalls: ToolCall[];
  /** Tool calls that were dropped because the answer was cut off. */
  toolCallsWithheld: number;
  /** The output cap that was sent, after the context budget. */
  maxTokens: number;
  /** False when the served window was unknown, so the request went through without the budget. */
  guarded: boolean;
}

/** Map an OpenAI-style finish_reason onto ours. Anything unknown is "other", never silently "stop". */
export function finishOf(reason: unknown): LlmResult["finishReason"] {
  return reason === "stop" || reason === "length" || reason === "tool_calls" ? reason : "other";
}

type ChatBody = {
  choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
/** One reader for both transports, so a cut-off answer is reported the same way everywhere. */
/** The output we ask for when the window allows it. The budget clamps it, and the result says what was sent. */
const REQUESTED_OUTPUT_TOKENS = 2048;

function llmResult(raw: unknown, b: Budget): LlmResult {
  const data = (raw ?? {}) as ChatBody;
  const finishReason = finishOf(data.choices?.[0]?.finish_reason);
  const truncated = finishReason === "length";
  const calls: ToolCall[] = (data.choices?.[0]?.message?.tool_calls ?? [])
    .map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.function?.name ?? "", arguments: c.function?.arguments ?? "{}" }))
    .filter((c) => c.name);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inToks: data.usage?.prompt_tokens ?? 0,
    outToks: data.usage?.completion_tokens ?? 0,
    finishReason,
    truncated,
    toolCalls: truncated ? [] : calls,
    toolCallsWithheld: truncated ? calls.length : 0,
    maxTokens: b.maxTokens,
    guarded: b.guarded,
  };
}

/** One chat message in OpenAI wire form. A `tool` message answers the call whose id it carries. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: { id: string; type?: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}
/** A function the model may call. `parameters` is a JSON schema. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}
export type ToolChoice = "auto" | "required" | "none";
/** A call the model asked for. `arguments` is the JSON text the model wrote. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The OpenAI `tools` and `tool_choice` fields, or nothing when no tools are offered. */
function wireTools(tools?: ToolSpec[], choice?: ToolChoice): Record<string, unknown> {
  if (!tools?.length) return {};
  return {
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters } })),
    tool_choice: choice ?? "auto",
  };
}

/** The prompt size the budget checks: message text, tool calls, and the tool schemas. Errs on the high side. */
function promptTokens(messages: ChatMessage[], tools?: ToolSpec[]): number {
  return estimateTokens(messages.map((m) => ({ content: (m.content ?? "") + (m.tool_calls ? JSON.stringify(m.tool_calls) : "") }))) + Math.ceil(JSON.stringify(tools ?? []).length / 3);
}

export async function runLlm(
  address: string,
  model: string,
  messages: ChatMessage[],
  opts: { transport?: Transport; apiKey?: string; timeoutMs?: number; contextWindow?: number; tools?: ToolSpec[]; toolChoice?: ToolChoice } = {},
): Promise<LlmResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = address.replace(/\/+$/, "");
  // The window is shared by the prompt and the output. Check the prompt first, and clamp the output to what is left.
  const b: Budget = budget(opts.contextWindow, promptTokens(messages, opts.tools), REQUESTED_OUTPUT_TOKENS);
  if (opts.transport === "cloudflare-workers-ai") {
    // Chat models serve an OpenAI-compatible endpoint at /ai/v1/chat/completions.
    const res = await meshFetch(`${base}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: b.maxTokens, ...wireTools(opts.tools, opts.toolChoice) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; errors?: { message?: string }[] };
    if (data.errors?.length) throw new Error(`LLM ${model}: ${data.errors[0].message}`);
    return llmResult(data, b);
  }
  const res = await meshFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: b.maxTokens, ...wireTools(opts.tools, opts.toolChoice) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`LLM ${model}: ${data.error.message}`);
  return llmResult(data, b);
}

/** A System One answer record, the same shape `dpi-backend/src/jev.ts` consumes. */
export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** Run a decision (System One style) against a decision endpoint. */
export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  inToks: number;
  outToks: number;
  guarded: boolean;
}

export async function runDecision(
  address: string,
  model: string,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  opts: { transport?: Transport; apiKey?: string; timeoutMs?: number; contextWindow?: number } = {},
): Promise<DecisionResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const base = address.replace(/\/+$/, "");
  // A decision has no output cap to clamp, but its prompt must still fit with room for an answer.
  const b: Budget = budget(opts.contextWindow, estimateTokens(JSON.stringify({ state, questions })), MIN_OUTPUT_TOKENS);
  if (opts.transport === "cloudflare-workers-ai") {
    const res = await meshFetch(`${base}/ai/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, input: { state, questions } }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Decision ${model}: HTTP ${res.status}`);
    const data = (await res.json()) as { result?: { answers?: Record<string, DecisionAnswer>; state?: string; result?: { answers?: Record<string, DecisionAnswer> }; usage?: { input_tokens?: number; output_tokens?: number } }; errors?: { message?: string }[] };
    if (data.errors?.length) throw new Error(`Decision ${model}: ${data.errors[0].message}`);
    // Hosted decision models return answers under result; a third-party System One wrapper adds one more level.
    const answers = data.result?.answers ?? data.result?.result?.answers ?? {};
    return { answers, inToks: data.result?.usage?.input_tokens ?? 0, outToks: data.result?.usage?.output_tokens ?? 0, guarded: b.guarded };
  }
  const res = await meshFetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`Decision ${model}: HTTP ${res.status}`);
  const data = (await res.json()) as { answers?: Record<string, DecisionAnswer>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`Decision ${model}: ${data.error.message}`);
  return { answers: data.answers ?? {}, inToks: data.usage?.input_tokens ?? 0, outToks: data.usage?.output_tokens ?? 0, guarded: b.guarded };
}

