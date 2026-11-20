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
import { cloudCostUsd, compareCosts, computeUsage, loadMeter, recordUsage, saveMeter, type UsageRecord } from "./meter.js";
import { listMeshHosts } from "./mesh.js";
import { loadTeamFeed, notifyReady } from "./notify.js";
import {
  disableCapability,
  enableCapability,
  loadRegistry,
  probeHost,
  recommendCapability,
  runDecision,
  runLlm,
  saveRegistry,
  selectCapability,
  type Capability,
  type CapabilityKind,
  type CapabilityRegistry,
  type DecisionQuestion,
} from "./capabilities.js";

/** Hosts to probe when the registry has no entry for them. Extend as hosts join the mesh. */
const DEFAULT_HOSTS: { host: string; address: string; ssh?: string }[] = listMeshHosts().map((h) => ({ host: h.name, address: `https://${h.hostname}`, ssh: h.name }));

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
/** Resolve the capability to call. Explicit id → deterministic; otherwise filter enabled candidates
 *  of the kind by `required` purposes and pick by the registry's selection mode (default `ab`,
 *  a random A/B choice; `auto` reuses the most-recently-used local with cloud fallback). */
function resolveForKind(reg: CapabilityRegistry, kind: CapabilityKind, opts: { capability?: string; prefer?: "local" | "cloud"; required?: string[] } = {}): Capability {
  return selectCapability(reg, kind, { capability: opts.capability, prefer: opts.prefer, required: opts.required, mode: reg.selectionMode ?? "ab" });
}

/** The secret (api key) input of a capability, if any. */
function apiKeyOf(cap: Capability): string | undefined {
  return cap.inputs.find((i) => i.secret)?.value;
}

/** Record a call in the meter (tokens + cloud billable cost + local interval) and mark the
 * capability as most-recently-used so automatic resolution reuses the hot model. */
function account(reg: CapabilityRegistry, cap: Capability, kind: "llm" | "decision", ms: number, inToks: number, outToks: number) {
  const meter = loadMeter();
  const now = Date.now();
  const costUsd = cap.transport === "cloudflare-workers-ai" ? cloudCostUsd(cap.model, inToks, outToks) : 0;
  const record: UsageRecord = { startedAt: now - ms, endedAt: now, model: cap.family ?? cap.name, kind, transport: cap.transport, inToks, outToks, costUsd };
  recordUsage(meter, record);
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
      const reg = load();
      const caps = reg.capabilities.filter((c) => !args.kind || c.kind === args.kind).map(publicCapability);
      return {
        content: [{ type: "text", text: JSON.stringify({ selectionMode: reg.selectionMode ?? "ab", capabilities: caps }, null, 2) }],
        structuredContent: { selectionMode: reg.selectionMode ?? "ab", capabilities: caps },
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
        address: z.string().min(1).max(200).describe("HTTP base, e.g. https://<host>.<your-zone> (Cloudflare Tunnel + Access)"),
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
      description: "Send messages to an enabled chat LLM capability (see list_capabilities) and return the assistant's reply. By default the model is A/B-selected: enabled LLMs matching the required purposes are filtered and one is chosen at random.",
      inputSchema: {
        capability: z.string().min(1).max(120).optional().describe("capability id from list_capabilities (omit for the default A/B random selection)"),
        prefer: z.enum(["local", "cloud"]).optional().describe("when no capability id is given, prefer a local or cloud capability (default local)"),
        required: z.array(z.string()).optional().describe("capabilities the model must have (purpose tags, all must match) before the A/B random pick, e.g. ['tool-use']"),
        messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).min(1).describe("conversation messages"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = resolveForKind(reg, "llm", { capability: args.capability, prefer: args.prefer ?? "local", required: args.required });
      const t0 = Date.now();
      const r = await runLlm(cap.address, cap.model, args.messages, { transport: cap.transport, apiKey: apiKeyOf(cap) });
      account(reg, cap, "llm", Date.now() - t0, r.inToks, r.outToks);
      return {
        content: [{ type: "text", text: r.text }],
        structuredContent: { capability: cap.id, model: cap.model, text: r.text, inToks: r.inToks, outToks: r.outToks },
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
        capability: z.string().min(1).max(120).optional().describe("capability id from list_capabilities (omit for the default A/B random selection)"),
        prefer: z.enum(["local", "cloud"]).optional().describe("when no capability id is given, prefer a local or cloud capability (default local)"),
        required: z.array(z.string()).optional().describe("capabilities the model must have (purpose tags, all must match) before the A/B random pick, e.g. ['jev-quality']"),
        state: z.record(z.string(), z.unknown()).describe("JSON state to judge"),
        questions: z.record(z.string(), z.unknown()).describe("System One questions: { name: { type: 'noul'|'choice', instructions, criteria? } }"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      const cap = resolveForKind(reg, "decision", { capability: args.capability, prefer: args.prefer ?? "local", required: args.required });
      const t0 = Date.now();
      const r = await runDecision(cap.address, cap.model, args.state, args.questions as Record<string, DecisionQuestion>, { transport: cap.transport, apiKey: apiKeyOf(cap) });
      account(reg, cap, "decision", Date.now() - t0, r.inToks, r.outToks);
      return {
        content: [{ type: "text", text: JSON.stringify({ capability: cap.id, model: cap.model, answers: r.answers, inToks: r.inToks, outToks: r.outToks }, null, 2) }],
        structuredContent: { capability: cap.id, model: cap.model, answers: r.answers, inToks: r.inToks, outToks: r.outToks },
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
    "compare_costs",
    {
      title: "Compare local vs cloud cost per model (billable vs opportunity)",
      description:
        "For every model family that has run on both backends: the cloud billable cost and $/min run rate, and the local electricity + wait-time opportunity cost (the time difference vs cloud, valued at the cloud rate — credited when local is faster). This is how local and cloud are weighed apples-to-apples.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const comparison = compareCosts(loadMeter());
      return {
        content: [{ type: "text", text: JSON.stringify(comparison, null, 2) }],
        structuredContent: { models: comparison },
      };
    },
  );

  server.registerTool(
    "notify_ready",
    {
      title: "Tell the team a capability is validated, deployed and ready",
      description:
        "Append a readiness entry to the shared team feed (DPI_MCP_TEAM_FEED) with the validation evidence, so the team — another agent or a human — can see that a discovered host capability was checked and turned on. This closes the discover → validate → deploy → notify loop.",
      inputSchema: {
        capability: z.string().min(1).max(80).describe("capability id (from enable_capability / list_capabilities)"),
        host: z.string().min(1).max(64).optional().describe("host the model runs on"),
        model: z.string().min(1).max(128).optional().describe("model id"),
        purpose: z.array(z.string()).optional().describe("purposes the capability serves, e.g. jev-quality"),
        validated: z.record(z.string(), z.unknown()).optional().describe("validation evidence: config checks, live test, end-to-end call timing"),
        message: z.string().min(1).max(400).describe("one-line readiness message for the team"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const entry = { at: Date.now(), kind: "capability-ready" as const, ...args };
      const feed = notifyReady(entry);
      return {
        content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
        structuredContent: { entry, feed },
      };
    },
  );

  server.registerTool(
    "team_feed",
    {
      title: "Read the team feed: what capabilities have been announced ready",
      description:
        "The shared feed of readiness announcements (notify_ready), newest last. Agents read this to learn what the swarm has already discovered, validated and deployed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const feed = loadTeamFeed();
      return {
        content: [{ type: "text", text: JSON.stringify({ entries: feed }, null, 2) }],
        structuredContent: { entries: feed },
      };
    },
  );

  server.registerTool(
    "set_selection_mode",
    {
      title: "Set the default model selection mode (A/B random vs auto)",
      description:
        "Choose how run_llm/run_decision pick a model when no capability id is given. `ab` (the default) filters enabled candidates by the required purposes and picks one at random; `auto` reuses the most-recently-used local model with cloud fallback.",
      inputSchema: { mode: z.enum(["ab", "auto"]).describe("selection mode to set") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const reg = load();
      reg.selectionMode = args.mode;
      save(reg);
      return {
        content: [{ type: "text", text: `selection mode is now ${args.mode}` }],
        structuredContent: { selectionMode: args.mode },
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
