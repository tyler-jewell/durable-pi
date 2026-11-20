// Per-host capability discovery and a capability lifecycle, driven entirely by MCP tools.
//
// Two layers:
//   hosts         what a probe found on a machine (llama.cpp /v1/models → text vs decisions)
//   capabilities  what an agent (or a person) has turned a host resource into: a named,
//                 callable thing with a state (recommended → enabled/disabled), the inputs
//                 it needs, and the options it exposes. Enabled capabilities are what the
//                 factory binds to (e.g. a `jev-quality` decision model).
//
// Auto-discover / auto-implement: `probeHost` is discovery; `recommendCapability` + the
// enable/disable state are the registry; `runLlm`/`runDecision` are implementation and are
// driven by the registry alone. A future host kind adds a probe spec + a capability kind —
// nothing else changes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accessHeadersFor } from "./mesh-config.js";
import type { Price } from "./cloud-catalog.js";

export type CapabilityKind = "llm" | "decision";
export type CapabilityState = "recommended" | "enabled" | "disabled";

export interface ModelInfo {
  id: string;
  kind: CapabilityKind; // `text` → llm, `decisions` → decision (from output_modalities)
  aliases: string[];
}

export interface HostCapability {
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

/** A value a capability needs to work (a key, a URL, a model id). */
export interface CapabilityInput {
  name: string;
  description: string;
  required: boolean;
  secret?: boolean; // masked in listings
  default?: string;
  value?: string; // filled by discovery or the enabler
}

/** A knob a capability exposes once enabled (thresholds, budgets, which role it serves). */
export interface CapabilityOption {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: unknown;
  value?: unknown;
  choices?: string[]; // for enum
}

export type CapabilityTransport = "openai-compat" | "cloudflare-workers-ai";

export interface Capability {
  id: string; // stable slug, e.g. studio-decision-clef-flash
  name: string; // display name
  kind: CapabilityKind;
  host: string; // discovery source; "" for a manual capability
  address: string; // callable HTTP base (host.address or a manual URL)
  model: string; // model id to call
  /** How to call the endpoint: a local OpenAI-compatible server, or the CF Workers AI API. */
  transport: CapabilityTransport;
  /** Canonical model family, shared by the local + cloud twins so costs can be paired. */
  family: string;
  /** Cloud models only: the catalog price, from discovery. Never a hardcoded table. */
  pricing?: Price;
  description: string;
  /** Roles this capability can fill, e.g. ["jev-quality"] or ["builder", "planner"]. */
  purpose: string[];
  state: CapabilityState;
  /** Auto turn-on: re-enable on next startup/discovery without asking again. */
  autoEnable: boolean;
  source: "discovered" | "agent";
  inputs: CapabilityInput[];
  options: CapabilityOption[];
  createdAt: number;
  updatedAt: number;
}

export type SelectionMode = "auto" | "ab";

export interface CapabilityRegistry {
  hosts: HostCapability[];
  capabilities: Capability[];
  /** Default model selection: `ab` picks randomly from the filtered candidates (A/B), `auto`
   *  picks the most-recently-used local first with cloud fallback. `ab` is the default. */
  selectionMode?: SelectionMode;
}

const REGISTRY = process.env.DPI_MCP_CAPABILITIES ?? join(homedir(), ".dpi-mcp", "capabilities.json");

function migrate(raw: unknown): CapabilityRegistry {
  if (Array.isArray(raw)) return { hosts: raw as HostCapability[], capabilities: [], selectionMode: "ab" }; // pre-lifecycle shape
  const r = (raw ?? {}) as Partial<CapabilityRegistry>;
  return { hosts: Array.isArray(r.hosts) ? r.hosts : [], capabilities: Array.isArray(r.capabilities) ? r.capabilities : [], selectionMode: r.selectionMode ?? "ab" };
}

export function loadRegistry(): CapabilityRegistry {
  try {
    return migrate(JSON.parse(readFileSync(REGISTRY, "utf8")));
  } catch {
    return { hosts: [], capabilities: [], selectionMode: "ab" };
  }
}

export function saveRegistry(reg: CapabilityRegistry): void {
  mkdirSync(join(homedir(), ".dpi-mcp"), { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
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

export function findCapability(reg: CapabilityRegistry, id: string): Capability | undefined {
  return reg.capabilities.find((c) => c.id === id);
}

/** An enabled capability that can fill `purpose`; undefined when none is enabled. */
export function resolveCapability(reg: CapabilityRegistry, purpose: string): Capability | undefined {
  return reg.capabilities.find((c) => c.state === "enabled" && c.purpose.includes(purpose));
}

/** Select the model to call, the zero system's default surface.
 *
 *  - an explicit `capability` is deterministic (the agent decides),
 *  - otherwise the enabled candidates of `kind` are filtered by `required` purposes (all must
 *    match), and `mode` picks: `ab` (the default) selects randomly from what remains — the A/B
 *    default — while `auto` reuses the most-recently-used local model with cloud fallback.
 */
export function selectCapability(
  reg: CapabilityRegistry,
  kind: CapabilityKind,
  opts: { capability?: string; prefer?: "local" | "cloud"; required?: string[]; mode?: SelectionMode } = {},
): Capability {
  if (opts.capability) {
    const cap = findCapability(reg, opts.capability);
    if (!cap) throw new Error(`capability "${opts.capability}" is not in the registry; list_capabilities shows what is available`);
    if (cap.state !== "enabled") throw new Error(`capability "${opts.capability}" is ${cap.state}; enable it first (enable_capability)`);
    if (cap.kind !== kind) throw new Error(`capability "${opts.capability}" is ${cap.kind}, not ${kind}`);
    return cap;
  }
  let enabled = reg.capabilities.filter((c) => c.state === "enabled" && c.kind === kind);
  if (opts.required?.length) {
    enabled = enabled.filter((c) => opts.required!.every((p) => c.purpose.includes(p)));
    if (!enabled.length) throw new Error(`no enabled ${kind} capability has every required purpose [${opts.required.join(", ")}]`);
  }
  if (!enabled.length) throw new Error(`no enabled ${kind} capability; list_capabilities + enable_capability first`);
  if ((opts.mode ?? reg.selectionMode ?? "ab") === "ab") return enabled[Math.floor(Math.random() * enabled.length)];
  const local = enabled.filter((c) => c.host !== "cloudflare").sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const cloud = enabled.filter((c) => c.host === "cloudflare");
  const first = opts.prefer === "cloud" ? cloud : local;
  const second = opts.prefer === "cloud" ? local : cloud;
  return first[0] ?? second[0] ?? enabled[0];
}

export interface RecommendArgs {
  host: string;
  model: string;
  name?: string;
  description: string;
  purpose: string[];
  transport?: CapabilityTransport;
  inputs?: { name: string; description?: string; required?: boolean; secret?: boolean; default?: string }[];
  options?: { name: string; description?: string; type: "string" | "number" | "boolean" | "enum"; default?: unknown; choices?: string[] }[];
}

/** Turn a discovered host model into a `recommended` capability (upsert by id). Returns it. */
export function recommendCapability(reg: CapabilityRegistry, args: RecommendArgs): Capability {
  const host = reg.hosts.find((h) => h.host === args.host);
  if (!host) throw new Error(`host "${args.host}" is not discovered yet; run discover_host first`);
  const m = host.models.find((x) => x.id === args.model);
  if (!m) throw new Error(`model "${args.model}" not found on ${args.host}; list_models shows what it exposes`);
  const now = Date.now();
  const id = slug(`${args.host}-${m.kind}-${args.model}`) || slug(args.model);
  const existing = findCapability(reg, id);
  const cap: Capability = {
    id,
    name: args.name ?? args.model,
    kind: m.kind,
    host: host.host,
    address: host.address,
    model: args.model,
    transport: args.transport ?? "openai-compat",
    family: familyOf(args.model),
    description: args.description,
    purpose: args.purpose,
    state: "recommended",
    autoEnable: false,
    source: "agent",
    inputs: (args.inputs ?? []).map((i) => ({ name: i.name, description: i.description ?? "", required: i.required ?? false, secret: i.secret ?? false, default: i.default, value: i.default })),
    options: (args.options ?? []).map((o) => ({ name: o.name, description: o.description ?? "", type: o.type, default: o.default, value: o.default, choices: o.choices })),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  reg.capabilities = [...reg.capabilities.filter((c) => c.id !== id), cap];
  return cap;
}

/** Enable a capability: apply inputs/options, check required inputs, set enabled + autoEnable. */
export function enableCapability(
  reg: CapabilityRegistry,
  id: string,
  opts: { inputs?: { name: string; value: string }[]; options?: { name: string; value: unknown }[]; autoEnable?: boolean } = {},
): Capability {
  const cap = findCapability(reg, id);
  if (!cap) throw new Error(`capability "${id}" is not in the registry; list_capabilities shows what is available`);
  for (const [name, value] of (opts.inputs ?? []).map((i) => [i.name, i.value] as const)) {
    const input = cap.inputs.find((x) => x.name === name);
    if (input) input.value = value;
  }
  for (const [name, value] of (opts.options ?? []).map((o) => [o.name, o.value] as const)) {
    const opt = cap.options.find((x) => x.name === name);
    if (opt) opt.value = value;
  }
  const missing = cap.inputs.filter((i) => i.required && !i.value).map((i) => i.name);
  if (missing.length) throw new Error(`capability "${id}" needs these inputs to enable: ${missing.join(", ")}`);
  cap.state = "enabled";
  cap.autoEnable = opts.autoEnable ?? true;
  cap.updatedAt = Date.now();
  return cap;
}

/** Disable a capability in place (kept in the registry for re-enable). Returns it. */
export function disableCapability(reg: CapabilityRegistry, id: string): Capability {
  const cap = findCapability(reg, id);
  if (!cap) throw new Error(`capability "${id}" is not in the registry`);
  cap.state = "disabled";
  cap.updatedAt = Date.now();
  return cap;
}

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
export async function probeHost(host: string, address: string, timeoutMs = 5000, headers?: Record<string, string>): Promise<HostCapability> {
  const base = address.replace(/\/+$/, "");
  const cap: HostCapability = { host, address: base, health: "offline", reachable: false, models: [], discoveredAt: Date.now() };
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
    const data = (await list.json()) as { data?: { id?: string; aliases?: string[]; architecture?: { output_modalities?: string[] } }[] };
    for (const m of data.data ?? []) {
      if (!m.id) continue;
      const modalities = m.architecture?.output_modalities ?? [];
      cap.models.push({ id: m.id, kind: modalities.includes("decisions") ? "decision" : "llm", aliases: m.aliases ?? [] });
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
}

/** Map an OpenAI-style finish_reason onto ours. Anything unknown is "other", never silently "stop". */
export function finishOf(reason: unknown): LlmResult["finishReason"] {
  return reason === "stop" || reason === "length" || reason === "tool_calls" ? reason : "other";
}

type ChatBody = { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
/** One reader for both transports, so a cut-off answer is reported the same way everywhere. */
function llmResult(data: ChatBody): LlmResult {
  const finishReason = finishOf(data.choices?.[0]?.finish_reason);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inToks: data.usage?.prompt_tokens ?? 0,
    outToks: data.usage?.completion_tokens ?? 0,
    finishReason,
    truncated: finishReason === "length",
  };
}

export async function runLlm(
  address: string,
  model: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { transport?: CapabilityTransport; apiKey?: string; timeoutMs?: number } = {},
): Promise<LlmResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = address.replace(/\/+$/, "");
  if (opts.transport === "cloudflare-workers-ai") {
    // Chat models serve an OpenAI-compatible endpoint at /ai/v1/chat/completions.
    const res = await meshFetch(`${base}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: 2048 }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; errors?: { message?: string }[] };
    if (data.errors?.length) throw new Error(`LLM ${model}: ${data.errors[0].message}`);
    return llmResult(data);
  }
  const res = await meshFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`LLM ${model}: ${data.error.message}`);
  return llmResult(data);
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
}

export async function runDecision(
  address: string,
  model: string,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  opts: { transport?: CapabilityTransport; apiKey?: string; timeoutMs?: number } = {},
): Promise<DecisionResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const base = address.replace(/\/+$/, "");
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
    // Cloudflare-hosted models (clef) return answers under result; third-party System One wraps once more.
    const answers = data.result?.answers ?? data.result?.result?.answers ?? {};
    return { answers, inToks: data.result?.usage?.input_tokens ?? 0, outToks: data.result?.usage?.output_tokens ?? 0 };
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
  return { answers: data.answers ?? {}, inToks: data.usage?.input_tokens ?? 0, outToks: data.usage?.output_tokens ?? 0 };
}
