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

export type CapabilityKind = "llm" | "decision";
export type CapabilityState = "recommended" | "enabled" | "disabled";

export interface ModelInfo {
  id: string;
  kind: CapabilityKind; // `text` → llm, `decisions` → decision (from output_modalities)
  aliases: string[];
}

export interface HostCapability {
  host: string;
  /** Canonical endpoint on the mesh, e.g. `http://studio.tail9d6cad.ts.net:8080`. */
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

export interface CapabilityRegistry {
  hosts: HostCapability[];
  capabilities: Capability[];
}

const REGISTRY = process.env.DPI_MCP_CAPABILITIES ?? join(homedir(), ".dpi-mcp", "capabilities.json");

function migrate(raw: unknown): CapabilityRegistry {
  if (Array.isArray(raw)) return { hosts: raw as HostCapability[], capabilities: [] }; // pre-lifecycle shape
  const r = (raw ?? {}) as Partial<CapabilityRegistry>;
  return { hosts: Array.isArray(r.hosts) ? r.hosts : [], capabilities: Array.isArray(r.capabilities) ? r.capabilities : [] };
}

export function loadRegistry(): CapabilityRegistry {
  try {
    return migrate(JSON.parse(readFileSync(REGISTRY, "utf8")));
  } catch {
    return { hosts: [], capabilities: [] };
  }
}

export function saveRegistry(reg: CapabilityRegistry): void {
  mkdirSync(join(homedir(), ".dpi-mcp"), { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function findCapability(reg: CapabilityRegistry, id: string): Capability | undefined {
  return reg.capabilities.find((c) => c.id === id);
}

/** An enabled capability that can fill `purpose`; undefined when none is enabled. */
export function resolveCapability(reg: CapabilityRegistry, purpose: string): Capability | undefined {
  return reg.capabilities.find((c) => c.state === "enabled" && c.purpose.includes(purpose));
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
    family: args.name ?? args.model,
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
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response | undefined> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch {
    return undefined;
  }
}

/**
 * Probe a host's HTTP base and derive its capabilities. llama.cpp 1.0.0 answers `/health`
 * and `/v1/models` (each model lists `architecture.output_modalities`: `text` or `decisions`);
 * a host that exposes `/v1/systemone` answers System One decision questions.
 */
export async function probeHost(host: string, address: string, timeoutMs = 5000): Promise<HostCapability> {
  const base = address.replace(/\/+$/, "");
  const cap: HostCapability = { host, address: base, health: "offline", reachable: false, models: [], discoveredAt: Date.now() };
  const health = await fetchJson(`${base}/health`, { method: "GET" }, timeoutMs);
  if (health?.ok) {
    const body = (await health.json().catch(() => undefined)) as { status?: string } | undefined;
    cap.health = body?.status === "ok" ? "online" : "offline";
  }
  cap.reachable = cap.health === "online";
  if (!cap.reachable) {
    cap.error = `${address} did not answer /health (the model server may bind 127.0.0.1 only; widen it or use tailscale serve)`;
    return cap;
  }
  const list = await fetchJson(`${base}/v1/models`, { method: "GET" }, timeoutMs);
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
    const res = await fetch(`${base}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: 2048 }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; errors?: { message?: string }[] };
    if (data.errors?.length) throw new Error(`LLM ${model}: ${data.errors[0].message}`);
    return { text: data.choices?.[0]?.message?.content ?? "", inToks: data.usage?.prompt_tokens ?? 0, outToks: data.usage?.completion_tokens ?? 0 };
  }
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`LLM ${model}: HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`LLM ${model}: ${data.error.message}`);
  return { text: data.choices?.[0]?.message?.content ?? "", inToks: data.usage?.prompt_tokens ?? 0, outToks: data.usage?.completion_tokens ?? 0 };
}

/** A System One answer record, the same shape `dpi-backend/src/jev.ts` consumes. */
export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** Run a System One decision (Jev/Clef style) against a decision endpoint. */
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
    const res = await fetch(`${base}/ai/run`, {
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
  const res = await fetch(`${base}/v1/systemone`, {
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
