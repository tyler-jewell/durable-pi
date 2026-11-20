// The tool store: one record per model, local or cloud. An enabled record is registered on the dpi-mcp server as
// an MCP tool of its own name. `ask_model` filters the enabled tools of a kind by the tags it requires, then picks
// one at random (A/B). A specific tool can always be called by name.
//
// The store holds no secrets. A cloud tool records the NAME of the environment variable that holds its key.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Price } from "./cloud-catalog.js";
import type { ModelKind, ModelInfo, Transport } from "./models.js";
import { familyOf, slug } from "./models.js";

export type SelectionMode = "ab" | "auto";

export interface ModelTool {
  /** The MCP tool name. Stable for a host and model: `model_<host>_<model>`. */
  name: string;
  source: "mesh" | "cloud";
  host: string;
  /** The HTTP base the calls go to. */
  address: string;
  /** The model id the server knows it by. */
  model: string;
  kind: ModelKind;
  transport: Transport;
  family: string;
  description: string;
  /** What the tool is for, used by `ask_model` to filter. Kind tags (chat, decision) are always present. */
  tags: string[];
  enabled: boolean;
  /** The window the server runs with. The context budget uses this. Undefined means unknown, and calls are unguarded. */
  servedContext?: number;
  /** The window the model was trained for. Informational only. */
  trainedContext?: number;
  /** Cloud tools: the catalog price, per million tokens. */
  pricing?: Price;
  /** Cloud tools: the environment variable that holds the API key. Never the key itself. */
  secretEnv?: string;
  discoveredAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface HostRecord {
  host: string;
  address: string;
  /** SSH target for config and launch-agent inspection (from ~/.ssh/config). */
  ssh?: string;
  lastProbeAt: number;
  error?: string;
  config?: { processes: { pid: number; ppid: number; command: string }[]; autoStartServices: string[] };
  test?: { health: string; kind: ModelKind; ms: number; sample?: string };
}

export interface ToolStore {
  version: 2;
  selectionMode: SelectionMode;
  hosts: HostRecord[];
  tools: ModelTool[];
}

const STORE = () => process.env.DPI_MCP_TOOLS ?? join(homedir(), ".dpi-mcp", "tools.json");

export function emptyStore(): ToolStore {
  return { version: 2, selectionMode: "ab", hosts: [], tools: [] };
}

export function loadStore(path = STORE()): ToolStore {
  if (!existsSync(path)) return emptyStore();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolStore>;
  return { version: 2, selectionMode: raw.selectionMode ?? "ab", hosts: raw.hosts ?? [], tools: raw.tools ?? [] };
}

export function saveStore(store: ToolStore, path = STORE()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

/** The MCP tool name for a model on a host. Lowercase, with dashes and underscores only, at most 64 characters. */
export function toolNameOf(host: string, model: string): string {
  return `model_${slug(host).replace(/-/g, "_")}_${slug(model).replace(/-/g, "_")}`.slice(0, 64);
}

/** The tags a tool of this kind always carries. */
export function kindTags(kind: ModelKind): string[] {
  return kind === "decision" ? ["decision"] : ["chat"];
}

/** Add or refresh a mesh model. A new model is disabled until someone enables it. A known model keeps its
 *  enabled state and its tags, and refreshes everything the host reports. */
export function upsertMeshTool(store: ToolStore, host: string, address: string, m: ModelInfo, now = Date.now()): ModelTool {
  const name = toolNameOf(host, m.id);
  const existing = store.tools.find((t) => t.name === name);
  const tool: ModelTool = {
    name,
    source: "mesh",
    host,
    address,
    model: m.id,
    kind: m.kind,
    transport: "openai-compat",
    family: familyOf(m.id),
    description: `${m.kind === "decision" ? "Decision" : "Chat"} model served by ${host}`,
    tags: [...new Set([...kindTags(m.kind), ...(existing?.tags ?? []).filter((t) => t !== "chat" && t !== "decision")])],
    enabled: existing?.enabled ?? false,
    servedContext: m.servedContext,
    trainedContext: m.trainedContext,
    discoveredAt: existing?.discoveredAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };
  store.tools = [...store.tools.filter((t) => t.name !== name), tool];
  return tool;
}

/** Enable or disable one tool by name. Returns the tool, or throws a message the caller can show. */
export function setEnabled(store: ToolStore, name: string, enabled: boolean, now = Date.now()): ModelTool {
  const tool = store.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" is not known; discover_models lists what can be enabled`);
  tool.enabled = enabled;
  tool.updatedAt = now;
  return tool;
}

/** Pick one tool. An explicit name is deterministic. Otherwise the enabled tools of the kind are filtered by the
 *  required tags (all of them must be present), and the mode decides: `ab` picks at random from what is left,
 *  `auto` picks the most recently used local tool, with cloud as the fallback. */
export function select(
  store: ToolStore,
  kind: ModelKind,
  opts: { name?: string; requires?: string[]; prefer?: "mesh" | "cloud"; mode?: SelectionMode; random?: () => number } = {},
): ModelTool {
  if (opts.name) {
    const t = store.tools.find((x) => x.name === opts.name);
    if (!t) throw new Error(`tool "${opts.name}" is not known; discover_models lists what can be enabled`);
    if (!t.enabled) throw new Error(`tool "${opts.name}" is disabled; enable_tool turns it on`);
    if (t.kind !== kind) throw new Error(`tool "${opts.name}" is a ${t.kind} tool, not ${kind}`);
    return t;
  }
  let eligible = store.tools.filter((t) => t.enabled && t.kind === kind);
  if (opts.requires?.length) eligible = eligible.filter((t) => opts.requires!.every((r) => t.tags.includes(r)));
  if (!eligible.length) {
    const why = opts.requires?.length ? ` with every required tag [${opts.requires.join(", ")}]` : "";
    throw new Error(`no enabled ${kind} tool${why}; enable one with enable_tool`);
  }
  if ((opts.mode ?? store.selectionMode) === "ab") {
    const r = opts.random ?? Math.random;
    return eligible[Math.min(eligible.length - 1, Math.floor(r() * eligible.length))];
  }
  const mesh = eligible.filter((t) => t.source === "mesh").sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  const cloud = eligible.filter((t) => t.source === "cloud");
  const [first, second] = opts.prefer === "cloud" ? [cloud, mesh] : [mesh, cloud];
  return first[0] ?? second[0] ?? eligible[0];
}
