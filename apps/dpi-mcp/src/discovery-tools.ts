// The discovery and control tools: find models on the mesh and in the cloud catalog, choose which ones are enabled,
// inspect a host, and read the cost meter and the team feed. Every enabled model is served as its own tool by
// model-tools.ts; this file only changes what is enabled.
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectHost } from "./host-inspect.js";
import { compareCosts, computeUsage, loadMeter, saveMeter } from "./meter.js";
import { notifyReady, loadTeamFeed } from "./notify.js";
import { discoverMeshModels } from "./mesh.js";
import { fetchCatalog, syncCloudTools } from "./cloud-catalog.js";
import { applyPolicy, loadPolicy } from "./policy.js";
import { loadStore, saveStore, setEnabled, setToolUse, storePath, upsertMeshTool, type HostRecord, type ToolStore } from "./tool-store.js";
import { probeToolUse, type ModelTools } from "./model-tools.js";
import { probeHost, type ModelInfo } from "./models.js";

/** The one change every discovery path makes: record the host, add its models as disabled tools, keep the rest. */
function recordHost(store: ToolStore, host: string, address: string, models: ModelInfo[], error?: string, now = Date.now()) {
  store.hosts = [
    ...store.hosts.filter((h) => h.host !== host),
    { host, address, ssh: store.hosts.find((h) => h.host === host)?.ssh, lastProbeAt: now, error } as HostRecord,
  ];
  for (const m of models) upsertMeshTool(store, host, address, m, now);
}

export function registerDiscoveryTools(server: McpServer, models: ModelTools): void {
  server.registerTool(
    "discover_models",
    {
      title: "Discover models: the mesh hosts and the cloud catalog",
      description:
        "Find models and record them. `mesh` probes every host in mesh.json (or one explicit host and address) and adds its local chat and decision models. `cloud` reads the Cloudflare Workers AI catalog with each text model's kind and price. A missing store is rebuilt from discovery plus the policy file: enablement comes from that policy, not from a hand edit. Re-running against an existing store refreshes what is known and keeps each model's enabled state.",
      inputSchema: {
        scope: z.enum(["mesh", "cloud", "all"]).optional().describe("what to discover (default all)"),
        host: z.string().min(1).max(64).optional().describe("probe only this host (needs address)"),
        address: z.string().min(1).max(200).optional().describe("the HTTP base of the host to probe"),
        ssh: z.string().max(128).optional().describe("ssh target for inspect_host, e.g. the host alias in ~/.ssh/config"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const scope = args.scope ?? "all";
      const fresh = !existsSync(storePath());
      const store = loadStore();
      const summary: Record<string, unknown> = {};
      if (scope === "mesh" || scope === "all") {
        if (args.host && args.address) {
          const probe = await probeHost(args.host, args.address);
          recordHost(store, args.host, args.address, probe.models, probe.error);
          if (args.ssh) store.hosts = store.hosts.map((h) => (h.host === args.host ? { ...h, ssh: args.ssh } : h));
          summary.mesh = [{ host: args.host, models: probe.models.length, error: probe.error ?? null }];
        } else {
          const found = await discoverMeshModels();
          summary.mesh = found.map((d) => ({ host: d.host.name, models: d.models.length, error: d.error ?? null }));
          for (const d of found) recordHost(store, d.host.name, d.address ?? `https://${d.host.hostname}`, d.models, d.error);
        }
      }
      if (scope === "cloud" || scope === "all") {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
        if (!accountId) summary.cloud = { error: "CLOUDFLARE_ACCOUNT_ID is not set" };
        else {
          const catalog = fetchCatalog();
          const r = syncCloudTools(store, catalog, `https://api.cloudflare.com/client/v4/accounts/${accountId}`);
          summary.cloud = { ...r, total: catalog.length, decision: catalog.filter((m) => m.kind === "decision").length, priced: catalog.filter((m) => m.price).length };
        }
      }
      if (fresh) applyPolicy(store, loadPolicy());
      saveStore(store);
      models.sync();
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
      };
    },
  );

  server.registerTool(
    "list_tools",
    {
      title: "List the model tools: enabled, disabled, kind, tags, served window, price",
      description:
        "Every model this system knows, as the tool it is served as. Filter by kind, source or enabled state. Secrets are never listed: a cloud tool shows only which environment variable holds its key.",
      inputSchema: {
        kind: z.enum(["llm", "decision"]).optional(),
        source: z.enum(["mesh", "cloud"]).optional(),
        enabled: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const store = loadStore();
      const tools = store.tools.filter((t) => (!args.kind || t.kind === args.kind) && (!args.source || t.source === args.source) && (args.enabled === undefined || t.enabled === args.enabled));
      return {
        content: [{ type: "text", text: JSON.stringify({ selectionMode: store.selectionMode, tools }, null, 2) }],
        structuredContent: { selectionMode: store.selectionMode, tools: tools as unknown as Record<string, unknown>[] },
      };
    },
  );

  server.registerTool(
    "probe_tool_use",
    {
      title: "Probe tool use: does a chat model answer with a structured tool call?",
      description:
        "Ask each enabled chat tool (or one tool, by name) to call a fixed test tool with a fixed value, and check that the server returned a structured call with that value. A model that passes gets the tool-use tag, which agent turns that offer tools require; one that fails loses it. Run it after discovery and before a model is used for agents.",
      inputSchema: { name: z.string().min(1).max(64).optional().describe("one chat tool to probe; default every enabled chat tool") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const store = loadStore();
      const targets = store.tools.filter((t) => t.kind === "llm" && (args.name ? t.name === args.name : t.enabled));
      if (args.name && targets.length === 0) throw new Error(`tool "${args.name}" is not a known chat tool`);
      const results: { name: string; ok: boolean; detail: string }[] = [];
      for (const tool of targets) {
        let verdict: { ok: boolean; detail: string };
        try {
          verdict = await probeToolUse(store, tool);
        } catch (error) {
          verdict = { ok: false, detail: `the probe call failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        setToolUse(store, tool.name, { ...verdict, checkedAt: Date.now() });
        saveStore(store);
        results.push({ name: tool.name, ...verdict });
      }
      models.sync();
      return {
        content: [{ type: "text", text: JSON.stringify({ probed: results }, null, 2) }],
        structuredContent: { probed: results },
      };
    },
  );

  for (const [name, on, title] of [
    ["enable_tool", true, "Enable a model tool: it is served and can be called"],
    ["disable_tool", false, "Disable a model tool: it is removed from the server's tool list"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: on
          ? "Turn a discovered model on. It appears as its own tool at once, and `ask_model` may pick it."
          : "Turn a model off. Its tool is removed from the list at once. Its record and its tags are kept, so enable_tool restores it.",
        inputSchema: { name: z.string().min(1).max(64).describe("the tool name from list_tools") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const store = loadStore();
        const tool = setEnabled(store, args.name, on);
        saveStore(store);
        models.sync();
        return {
          content: [{ type: "text", text: JSON.stringify({ name: tool.name, enabled: tool.enabled }, null, 2) }],
          structuredContent: { name: tool.name, enabled: tool.enabled },
        };
      },
    );
  }

  server.registerTool(
    "set_selection_mode",
    {
      title: "Set how ask_model picks among candidates: A/B random or auto",
      description:
        "`ab` (the default) picks at random from the enabled tools that match the required tags. `auto` picks the most recently used mesh tool, with cloud as the fallback. A call that names a tool is always deterministic.",
      inputSchema: { mode: z.enum(["ab", "auto"]).describe("selection mode to set") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const store = loadStore();
      store.selectionMode = args.mode;
      saveStore(store);
      return {
        content: [{ type: "text", text: `selection mode is now ${args.mode}` }],
        structuredContent: { selectionMode: args.mode },
      };
    },
  );

  server.registerTool(
    "inspect_host",
    {
      title: "Inspect a host: its model-server config, launchd auto-start, and a live test",
      description:
        "SSH into a discovered host and report how its model server runs: the server processes and their arguments (including the served window), whether a launch agent auto-starts it, and a live call with timing. The result is kept on the host record.",
      inputSchema: { host: z.string().min(1).max(64).describe("host name from list_tools") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const store = loadStore();
      const record = store.hosts.find((h) => h.host === args.host);
      if (!record) throw new Error(`host "${args.host}" is not known; discover_models lists the hosts`);
      if (!record.ssh) throw new Error(`host "${args.host}" has no ssh target; discover_models takes ssh`);
      const hostModels = store.tools.filter((t) => t.host === args.host && t.kind).map((t) => ({ id: t.model, kind: t.kind }));
      const result = await inspectHost(record.ssh, record.address, hostModels);
      record.config = result.config;
      record.test = result.test;
      record.lastProbeAt = Date.now();
      saveStore(store);
      return {
        content: [{ type: "text", text: JSON.stringify({ host: args.host, config: result.config, test: result.test }, null, 2) }],
        structuredContent: { host: args.host, config: result.config as unknown as Record<string, unknown>, test: result.test as unknown as Record<string, unknown> },
      };
    },
  );

  server.registerTool(
    "list_usage",
    {
      title: "Local model cost: kWh consumed and cost at the configured electricity price",
      description:
        "The local meter: total kWh (idle power over elapsed time plus load power over the union of call intervals, so concurrent calls share the load), the electricity price and watts, and the dollar cost. Every call through a model tool is metered.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const summary = computeUsage(loadMeter());
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "compare_costs",
    {
      title: "Compare local vs cloud cost per model family",
      description:
        "For every model family that has run on both sides: the cloud billed cost and $/min run rate, and the local electricity plus the wait-time opportunity cost (the time difference vs cloud, valued at the cloud rate, credited when local is faster).",
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
    "update_settings",
    {
      title: "Update local cost settings (electricity price and power draw)",
      description: "Edit electricityUsdPerKwh (default 0.15), idleWatts and loadWatts. These are the settings list_usage and the realized-cost figures use.",
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

  server.registerTool(
    "notify_ready",
    {
      title: "Tell the team a tool is validated, deployed and ready",
      description: "Append a readiness entry to the shared team feed, with the validation evidence, so another agent or a person can see what was checked and turned on.",
      inputSchema: {
        tool: z.string().min(1).max(80).optional().describe("the tool name that is ready"),
        host: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(128).optional(),
        purpose: z.array(z.string()).optional(),
        validated: z.record(z.string(), z.unknown()).optional().describe("validation evidence: checks, live test, timing"),
        message: z.string().min(1).max(400).describe("one-line readiness message"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const entry = { at: Date.now(), kind: "ready" as const, ...args };
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
      title: "Read the team feed: what has been announced ready",
      description: "The shared feed of readiness announcements (notify_ready), newest last.",
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
}
