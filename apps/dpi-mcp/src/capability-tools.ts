// MCP tools for the capability lifecycle. Agents drive the whole loop with tools alone:
//
//   discover_host        probe a host → records its LLMs / decision models
//   list_models          read what each host exposes (raw discovery)
//   recommend_capability turn a discovered model into a named capability (recommended)
//   enable_capability    supply any required inputs/options and turn it on now
//   disable_capability   toggle it off (stays in settings for later re-enable)
//   list_capabilities    the settings surface: state, inputs, options for every capability
//   run_llm / run_decision  use an enabled capability
//
// A recommendation that is not enabled immediately stays in the registry (`recommended`),
// so a later `list_capabilities` (or the settings UI) shows it and `enable_capability`
// turns it on with the same inputs/options the agent recorded.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectHost } from "./host-inspect.js";
import { computeUsage, loadMeter, recordUsage, saveMeter, type UsageRecord } from "./meter.js";
import {
  disableCapability,
  enableCapability,
  findCapability,
  loadRegistry,
  probeHost,
  recommendCapability,
  runDecision,
  runLlm,
  saveRegistry,
  type Capability,
  type CapabilityKind,
  type CapabilityRegistry,
  type DecisionQuestion,
} from "./capabilities.js";

/** Hosts to probe when the registry has no entry for them. Extend as hosts join the mesh. */
const DEFAULT_HOSTS: { host: string; address: string; ssh?: string }[] = [
  { host: "studio", address: "http://studio.tail9d6cad.ts.net:8080", ssh: "studio" },
];

function load(): CapabilityRegistry {
  return loadRegistry();
}

function save(reg: CapabilityRegistry): void {
  saveRegistry(reg);
}

/** Mask secret input values before returning them to a caller. */
function publicCapability(c: Capability): Capability {
  return {
    ...c,
    inputs: c.inputs.map((i) => (i.secret ? { ...i, value: i.value ? "••••" : undefined } : i)),
  };
}

/** Resolve the capability to call: an explicit id (the agent decides), else the default — an
 * enabled capability of the requested kind, local hosts first with cloud as fallback (or the
 * reverse when `prefer` is "cloud"). In automatic mode local models sort by most-recently-used,
 * so the next call reuses the already-loaded model and avoids a swap (next-best-cheapest). */
function resolveForKind(reg: CapabilityRegistry, kind: CapabilityKind, opts: { capability?: string; prefer?: "local" | "cloud" } = {}): Capability {
  if (opts.capability) {
    const cap = findCapability(reg, opts.capability);
    if (!cap) throw new Error(`capability "${opts.capability}" is not in the registry; list_capabilities shows what is available`);
    if (cap.state !== "enabled") throw new Error(`capability "${opts.capability}" is ${cap.state}; enable it first (enable_capability)`);
    if (cap.kind !== kind) throw new Error(`capability "${opts.capability}" is ${cap.kind}, not ${kind}`);
    return cap;
  }
  const enabled = reg.capabilities.filter((c) => c.state === "enabled" && c.kind === kind);
  const local = enabled.filter((c) => c.host !== "cloudflare").sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const cloud = enabled.filter((c) => c.host === "cloudflare");
  const first = opts.prefer === "cloud" ? cloud : local;
  const second = opts.prefer === "cloud" ? local : cloud;
  const cap = first[0] ?? second[0] ?? enabled[0];
  if (!cap) throw new Error(`no enabled ${kind} capability; list_capabilities + enable_capability first`);
  return cap;
}

/** The secret (api key) input of a capability, if any. */
function apiKeyOf(cap: Capability): string | undefined {
  return cap.inputs.find((i) => i.secret)?.value;
}

/** Record a local call in the meter and mark the capability as most-recently-used. */
function account(reg: CapabilityRegistry, cap: Capability, kind: "llm" | "decision", ms: number) {
  if (cap.transport === "openai-compat") {
    const meter = loadMeter();
    const now = Date.now();
    const record: UsageRecord = { startedAt: now - ms, endedAt: now, model: cap.model, kind };
    recordUsage(meter, record);
  }
  cap.updatedAt = Date.now();
  saveRegistry(reg);
}

export function registerCapabilityTools(server: McpServer): void {
  server.registerTool(
    "list_models",
    {
      title: "List the LLMs and decision models each mesh host exposes",
      description:
        "Read the raw per-host discovery: for every host, the models it serves, whether each is a chat LLM or a decision (System One/Jev/Clef) model, and health. Use recommend_capability to turn one into a usable capability, or run_llm/run_decision on an enabled capability.",
      inputSchema: { refresh: z.boolean().optional().describe("re-probe every known host first") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      if (args.refresh) {
        const known = [...DEFAULT_HOSTS, ...reg.hosts.map((c) => ({ host: c.host, address: c.address, ssh: c.ssh }))].filter(
          (h, i, a) => a.findIndex((x) => x.host === h.host) === i,
        );
        reg.hosts = await Promise.all(known.map((h) => probeHost(h.host, h.address)));
        save(reg);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ hosts: reg.hosts }, null, 2) }],
        structuredContent: { hosts: reg.hosts },
      };
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities: what is enabled, disabled, or recommended (the settings surface)",
      description:
        "Every capability an agent has recommended or enabled, with its state, the inputs it needs and the options it exposes (secret values are masked). This is the registry a settings UI toggles. Enable a recommended one with enable_capability; turn one off with disable_capability.",
      inputSchema: { kind: z.enum(["llm", "decision"]).optional().describe("filter by kind") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const caps = load().capabilities.filter((c) => !args.kind || c.kind === args.kind).map(publicCapability);
      return {
        content: [{ type: "text", text: JSON.stringify({ capabilities: caps }, null, 2) }],
        structuredContent: { capabilities: caps },
      };
    },
  );

  server.registerTool(
    "discover_host",
    {
      title: "Probe a mesh host and record its LLMs and decision models",
      description:
        "Probe a host's HTTP base for /health and /v1/models, derive its chat LLMs and decision models, and record them in the registry (hosts). Then recommend_capability can turn a model into a usable capability.",
      inputSchema: {
        host: z.string().min(1).max(64).describe("host id, e.g. studio"),
        address: z.string().min(1).max(200).describe("HTTP base, e.g. http://studio.tail9d6cad.ts.net:8080"),
        ssh: z.string().max(128).optional().describe("ssh target for config/launch-agent inspection, e.g. studio (from ~/.ssh/config)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const cap = await probeHost(args.host, args.address);
      if (args.ssh) cap.ssh = args.ssh;
      const reg = load();
      reg.hosts = [...reg.hosts.filter((c) => c.host !== cap.host), cap];
      save(reg);
      return {
        content: [{ type: "text", text: JSON.stringify(cap, null, 2) }],
        structuredContent: cap as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "inspect_host",
    {
      title: "Inspect a host's model-server config, launchd auto-start, and run a live test",
      description:
        "SSH into a host and report how its model server runs: the llama-server processes (args, ports, model dir, aliases), whether any launchd service auto-starts it, and a live decision/chat test with timing. Merges the result into the host's registry entry. This is how an agent learns the full config without hand-rolling ssh.",
      inputSchema: { host: z.string().min(1).max(64).describe("host id from list_models") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const host = reg.hosts.find((h) => h.host === args.host);
      if (!host) throw new Error(`host "${args.host}" is not discovered; run discover_host first`);
      if (!host.ssh) throw new Error(`host "${args.host}" has no ssh target; run discover_host with ssh: "<target>"`);
      const result = await inspectHost(host.ssh, host.address, host.models.map((m) => ({ id: m.id, kind: m.kind })));
      host.config = result.config;
      host.test = result.test;
      host.discoveredAt = Date.now();
      save(reg);
      return {
        content: [{ type: "text", text: JSON.stringify({ host: host.host, config: host.config, test: host.test }, null, 2) }],
        structuredContent: { host: host.host, config: host.config, test: host.test },
      };
    },
  );

  server.registerTool(
    "recommend_capability",
    {
      title: "Turn a discovered host model into a capability (recommended, not yet enabled)",
      description:
        "Propose a capability from a host's discovered models: give it a purpose (e.g. jev-quality, builder), any inputs it needs and options it exposes. It is saved as `recommended`; enable_capability turns it on now, or it stays in list_capabilities for a later toggle. Run discover_host first if the host is not known.",
      inputSchema: {
        host: z.string().min(1).max(64).describe("host id from list_models"),
        model: z.string().min(1).max(128).describe("model id from list_models"),
        name: z.string().min(1).max(80).optional().describe("display name; defaults to the model id"),
        description: z.string().min(1).max(400).describe("what this capability does"),
        purpose: z.array(z.string().min(1)).min(1).describe("roles it fills, e.g. [\"jev-quality\"] or [\"builder\", \"planner\"]"),
        inputs: z
          .array(
            z.object({
              name: z.string().min(1).max(40),
              description: z.string().max(200).optional(),
              required: z.boolean().optional(),
              secret: z.boolean().optional(),
              default: z.string().optional(),
            }),
          )
          .optional()
          .describe("values the capability needs beyond endpoint/model (e.g. an api key)"),
        options: z
          .array(
            z.object({
              name: z.string().min(1).max(40),
              description: z.string().max(200).optional(),
              type: z.enum(["string", "number", "boolean", "enum"]),
              default: z.unknown().optional(),
              choices: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe("knobs the capability exposes once enabled (e.g. a decision threshold)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = recommendCapability(reg, {
        host: args.host,
        model: args.model,
        name: args.name,
        description: args.description,
        purpose: args.purpose,
        inputs: args.inputs,
        options: args.options,
      });
      save(reg);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ capability: publicCapability(cap), next: "enable_capability to turn it on now, or it stays in list_capabilities/settings" }, null, 2),
          },
        ],
        structuredContent: publicCapability(cap) as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "enable_capability",
    {
      title: "Enable a recommended or disabled capability, supplying its inputs and options",
      description:
        "Turn a capability on. Provide any required input values (name → value) and option overrides; missing required inputs are reported. The capability then binds into its purpose (e.g. the factory's jev-quality gate).",
      inputSchema: {
        id: z.string().min(1).max(120).describe("capability id from list_capabilities"),
        inputs: z.array(z.object({ name: z.string().min(1).max(40), value: z.string() })).optional().describe("input values to set"),
        options: z.array(z.object({ name: z.string().min(1).max(40), value: z.unknown() })).optional().describe("option overrides to set"),
        autoEnable: z.boolean().optional().describe("turn on automatically after every startup/discovery without re-asking (default true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = enableCapability(reg, args.id, { inputs: args.inputs, options: args.options, autoEnable: args.autoEnable });
      save(reg);
      return {
        content: [{ type: "text", text: JSON.stringify({ capability: publicCapability(cap), enabled: true, autoEnable: cap.autoEnable }, null, 2) }],
        structuredContent: { id: cap.id, state: cap.state, autoEnable: cap.autoEnable, enabled: true },
      };
    },
  );

  server.registerTool(
    "disable_capability",
    {
      title: "Disable a capability (it stays in settings for later re-enable)",
      description: "Toggle a capability off without deleting it. Its inputs and options are kept, so enable_capability can turn it back on.",
      inputSchema: { id: z.string().min(1).max(120).describe("capability id from list_capabilities") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = disableCapability(reg, args.id);
      save(reg);
      return {
        content: [{ type: "text", text: JSON.stringify({ id: cap.id, state: cap.state, note: "kept in settings; enable_capability re-enables" }, null, 2) }],
        structuredContent: { id: cap.id, state: cap.state },
      };
    },
  );

  server.registerTool(
    "run_llm",
    {
      title: "Run a chat completion on an enabled LLM capability",
      description: "Send messages to an enabled chat LLM capability (see list_capabilities) and return the assistant's reply.",
      inputSchema: {
        capability: z.string().min(1).max(120).optional().describe("capability id from list_capabilities (omit for automatic: local first, most-recently-used, cloud fallback)"),
        prefer: z.enum(["local", "cloud"]).optional().describe("when no capability id is given, prefer a local or cloud capability (default local)"),
        messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).min(1).describe("conversation messages"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = resolveForKind(reg, "llm", { capability: args.capability, prefer: args.prefer ?? "local" });
      const t0 = Date.now();
      const text = await runLlm(cap.address, cap.model, args.messages, { transport: cap.transport, apiKey: apiKeyOf(cap) });
      account(reg, cap, "llm", Date.now() - t0);
      return {
        content: [{ type: "text", text }],
        structuredContent: { capability: cap.id, model: cap.model, text },
      };
    },
  );

  server.registerTool(
    "run_decision",
    {
      title: "Run a System One decision (Jev/Clef) on an enabled decision capability",
      description:
        "Judge a JSON state with bounded questions on an enabled decision capability (see list_capabilities), returning noul/choice answers. This is the same envelope the factory's jev-quality reviewer gate uses.",
      inputSchema: {
        capability: z.string().min(1).max(120).optional().describe("capability id from list_capabilities (omit for automatic: local first, most-recently-used, cloud fallback)"),
        prefer: z.enum(["local", "cloud"]).optional().describe("when no capability id is given, prefer a local or cloud capability (default local)"),
        state: z.record(z.string(), z.unknown()).describe("JSON state to judge"),
        questions: z.record(z.string(), z.unknown()).describe("System One questions: { name: { type: 'noul'|'choice', instructions, criteria? } }"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = resolveForKind(reg, "decision", { capability: args.capability, prefer: args.prefer ?? "local" });
      const t0 = Date.now();
      const answers = await runDecision(cap.address, cap.model, args.state, args.questions as Record<string, DecisionQuestion>, { transport: cap.transport, apiKey: apiKeyOf(cap) });
      account(reg, cap, "decision", Date.now() - t0);
      return {
        content: [{ type: "text", text: JSON.stringify({ capability: cap.id, model: cap.model, answers }, null, 2) }],
        structuredContent: { capability: cap.id, model: cap.model, answers },
      };
    },
  );

  server.registerTool(
    "list_usage",
    {
      title: "Local model cost: kWh consumed and cost at the configured electricity price",
      description:
        "Report the local model meter: total kWh (idle power over elapsed time plus load power over the union of call intervals, so concurrent calls share the load), the configured electricity price/kWh and watts, and the dollar cost. Local calls through run_llm/run_decision are metered automatically.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const meter = loadMeter();
      const summary = computeUsage(meter);
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update local cost settings (electricity price and power draw)",
      description:
        "Edit the local-cost model: electricityUsdPerKwh (global price per kWh, default 0.15), idleWatts and loadWatts (the Studio's power draw). These are the settings list_usage reports and cost uses.",
      inputSchema: {
        electricityUsdPerKwh: z.number().positive().optional(),
        idleWatts: z.number().nonnegative().optional(),
        loadWatts: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const meter = loadMeter();
      if (args.electricityUsdPerKwh !== undefined) meter.settings.electricityUsdPerKwh = args.electricityUsdPerKwh;
      if (args.idleWatts !== undefined) meter.settings.idleWatts = args.idleWatts;
      if (args.loadWatts !== undefined) meter.settings.loadWatts = args.loadWatts;
      saveMeter(meter);
      return {
        content: [{ type: "text", text: JSON.stringify({ settings: meter.settings }, null, 2) }],
        structuredContent: { settings: meter.settings } as unknown as Record<string, unknown>,
      };
    },
  );
}
