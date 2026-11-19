// The .tsf factory roster: load and validate .tsf/tsf.config.yaml from a project directory.
// The roster is data, not code — it names the team (planner/builder/scout/reviewer/documenter),
// each with a model, thinking level, bounded toolset and repo paths it may write.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface TsfPrompt {
  system?: string;
  user?: string;
}

export interface TsfAgent {
  name: string;
  purpose: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  /** Repo paths the agent may change; [] means read-only with respect to the repo. */
  writes?: string[];
  prompt?: TsfPrompt;
  /** Run this agent's review through the Jev quality gate. */
  jev?: boolean;
}

export interface TsfDefaults {
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  writes?: string[];
  /** Repo paths no agent may change. */
  protected?: string[];
}

export interface TsfConfig {
  defaults: TsfDefaults;
  agents: TsfAgent[];
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const strList = (v: unknown, where: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw Error(`${where} must be a list of strings`);
  return v as string[];
};

const str = (v: unknown, where: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw Error(`${where} must be a string`);
  return v;
};

function promptOf(raw: unknown, where: string): TsfPrompt | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Error(`${where}.prompt must be a map`);
  const p = raw as Record<string, unknown>;
  const prompt: TsfPrompt = {};
  if (p.system !== undefined) prompt.system = str(p.system, `${where}.prompt.system`);
  if (p.user !== undefined) prompt.user = str(p.user, `${where}.prompt.user`);
  return prompt.system || prompt.user ? prompt : undefined;
}

/** Parse and validate a tsf.config.yaml document. */
export function parseTsfConfig(text: string, file = "tsf.config.yaml"): TsfConfig {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const defaultsRaw = (raw.defaults ?? {}) as Record<string, unknown>;
  const agentsRaw = raw.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) throw Error(`${file}: agents must be a non-empty list`);

  const defaults: TsfDefaults = {
    provider: str(defaultsRaw.provider, `${file}: defaults.provider`),
    model: str(defaultsRaw.model, `${file}: defaults.model`),
    thinking: str(defaultsRaw.thinking, `${file}: defaults.thinking`),
    tools: strList(defaultsRaw.tools, `${file}: defaults.tools`),
    writes: strList(defaultsRaw.writes, `${file}: defaults.writes`),
    protected: strList(defaultsRaw.protected, `${file}: defaults.protected`),
  };

  const seen = new Set<string>();
  const agents = agentsRaw.map((a, i) => {
    const where = `${file}: agents[${i}]`;
    if (typeof a !== "object" || a === null || Array.isArray(a)) throw Error(`${where} must be a map`);
    const o = a as Record<string, unknown>;
    const name = str(o.name, `${where}.name`);
    if (!name || !NAME_RE.test(name)) throw Error(`${where}.name must match /^[a-z][a-z0-9-]{0,31}$/`);
    if (seen.has(name)) throw Error(`${file}: duplicate agent name "${name}"`);
    seen.add(name);
    const purpose = str(o.purpose, `${where}.purpose`);
    if (!purpose) throw Error(`${where}.purpose is required`);
    const agent: TsfAgent = { name, purpose };
    if (o.model !== undefined) agent.model = str(o.model, `${where}.model`);
    if (o.thinking !== undefined) agent.thinking = str(o.thinking, `${where}.thinking`);
    if (o.tools !== undefined) agent.tools = strList(o.tools, `${where}.tools`);
    if (o.writes !== undefined) agent.writes = strList(o.writes, `${where}.writes`);
    if (o.jev !== undefined) {
      if (typeof o.jev !== "boolean") throw Error(`${where}.jev must be a boolean`);
      agent.jev = o.jev;
    }
    agent.prompt = promptOf(o.prompt, where);
    return agent;
  });

  return { defaults, agents };
}

/** Load a roster from <dir>/.tsf/tsf.config.yaml; undefined when the project has no factory. */
export function loadTsfConfig(dir: string): TsfConfig | undefined {
  const file = join(dir, ".tsf", "tsf.config.yaml");
  if (!existsSync(file)) return undefined;
  return parseTsfConfig(readFileSync(file, "utf8"), file);
}
