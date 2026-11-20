// The zero bootstrap: take a bare system to a working set of local models in one run.
//
//   discover every mesh host (mesh.json, Cloudflare Tunnel + Access)
//   → choose which local models to enable (the dialog; every discovered model is pre-checked)
//   → enable each as a tool and test it live with a real call
//   → report realized cost: electricity, against the same tokens priced on the cloud twin
//   → prove the A/B selection reaches every eligible tool and nothing else
//   → "all models tested, systems a go", with the selection mode set to A/B random.
//
// Validation calls local models only. A cloud twin is priced from its catalog rate and the tokens the local run
// used. It is never called. Opportunity cost (wait time) is not counted: the report shows realized spend only.
import { callChat, callDecision } from "./model-tools.js";
import { marginalElectricityUsd, DEFAULT_SETTINGS, type CostSettings } from "./meter.js";
import { syncCloudTools, tokenCostUsd, type CatalogModel } from "./cloud-catalog.js";
import type { MeshModelDiscovery } from "./mesh.js";
import { notifyReady } from "./notify.js";
import { loadStore, saveStore, select, setEnabled, upsertMeshTool, kindTags, type ModelTool, type ToolStore } from "./tool-store.js";
import type { DecisionQuestion } from "./models.js";

export interface Candidate {
  host: string;
  address: string;
  id: string;
  kind: "llm" | "decision";
}

/** Every discovered local model, in host order. A host with no model contributes nothing. */
export function candidatesOf(discovered: MeshModelDiscovery[]): Candidate[] {
  return discovered.flatMap((d) => (d.address ? d.models.map((m) => ({ host: d.host.name, address: d.address!, id: m.id, kind: m.kind })) : []));
}

/**
 * Apply the user's answer to the checklist. `defaults` is the pre-checked state.
 *   ""                 → submit the defaults
 *   "a" / "all"        → every model
 *   "n" / "none"       → none
 *   "2 5"  or "2,5"    → toggle items 2 and 5 relative to the defaults
 * Anything that is not a valid 1-based index is ignored, so a typo never enables a model by accident.
 */
export function parseSelection(answer: string, count: number, defaults: boolean[]): boolean[] {
  const text = answer.trim().toLowerCase();
  if (text === "") return [...defaults];
  if (text === "a" || text === "all") return Array.from({ length: count }, () => true);
  if (text === "n" || text === "none") return Array.from({ length: count }, () => false);
  const out = [...defaults];
  for (const token of text.split(/[\s,]+/)) {
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= count) out[n - 1] = !out[n - 1];
  }
  return out;
}

/** The auto-selection policy: every discovered local model is pre-checked. The user can deselect any of them. */
export function autoSelection(candidates: Candidate[]): boolean[] {
  return candidates.map(() => true);
}

export interface ModelTest {
  tool: string;
  host: string;
  model: string;
  kind: "llm" | "decision";
  ok: boolean;
  ms: number;
  inToks: number;
  outToks: number;
  /** Marginal electricity for this run (realized, excludes opportunity cost). */
  electricityUsd: number;
  /** The same tokens priced on the cloud twin. Undefined when there is no priced twin. */
  cloudEquivUsd?: number;
  cloudModel?: string;
  sample: string;
  error?: string;
}

const PROBE_QUESTION: Record<string, DecisionQuestion> = {
  verdict: { type: "choice", instructions: "Is the system ready to run?", criteria: { approve: "yes, ready", revise: "unsure", reject: "no" } },
};
const PROBE_STATE = { plan: "zero bootstrap probe", facts: "the model server answered /health" };

/** The cloud twin: a cloud tool of the same kind and family. */
export function cloudTwinOf(store: ToolStore, tool: ModelTool): ModelTool | undefined {
  return store.tools.find((t) => t.source === "cloud" && t.kind === tool.kind && t.family === tool.family);
}

/** Run one live call on an enabled local tool. The call is metered, and the store records when it was used. */
export async function testTool(store: ToolStore, tool: ModelTool, settings: CostSettings = DEFAULT_SETTINGS): Promise<ModelTest> {
  const base = { tool: tool.name, host: tool.host, model: tool.model, kind: tool.kind };
  const t0 = Date.now();
  let ok = false;
  let sample = "";
  let inToks = 0;
  let outToks = 0;
  let error: string | undefined;
  try {
    if (tool.kind === "decision") {
      const r = await callDecision(store, tool, PROBE_STATE, PROBE_QUESTION);
      const answer = r.answers.verdict;
      ok = answer?.type === "choice" && typeof answer.choice === "string";
      sample = answer?.type === "choice" ? `${answer.choice} (${(answer.confidence ?? 0).toFixed(2)})` : JSON.stringify(answer);
      inToks = r.inToks;
      outToks = r.outToks;
    } else {
      const r = await callChat(store, tool, [{ role: "user", content: "Reply with exactly: OK" }]);
      ok = /\bOK\b/i.test(r.text) && !r.truncated;
      sample = r.text.trim().slice(0, 60);
      inToks = r.inToks;
      outToks = r.outToks;
    }
  } catch (e) {
    error = String((e as Error).message).slice(0, 200);
  }
  const ms = Date.now() - t0;
  const twin = cloudTwinOf(store, tool);
  return {
    ...base,
    ok: ok && !error,
    ms,
    inToks,
    outToks,
    electricityUsd: marginalElectricityUsd(ms, settings),
    cloudEquivUsd: tokenCostUsd(twin?.pricing, inToks, outToks),
    cloudModel: twin?.model,
    sample,
    error,
  };
}

export interface RealizedCost {
  /** Electricity over every run. */
  electricityUsd: number;
  /** Electricity over only the priced runs: the side the savings are measured on. */
  pricedElectricityUsd: number;
  /** Sum of the cloud-equivalent over runs that had a priced twin. */
  cloudEquivUsd: number;
  /** Cloud-equivalent minus the electricity those same runs used. */
  savedUsd: number;
  pricedRuns: number;
  unpricedRuns: number;
}

/** Realized cost only: electricity spent, the cloud bill the same tokens would have been, and the difference.
 *  Runs without a priced cloud twin are counted, never guessed. */
export function realizedCost(tests: ModelTest[]): RealizedCost {
  let electricityUsd = 0;
  let cloudEquivUsd = 0;
  let pricedElectricityUsd = 0;
  let pricedRuns = 0;
  for (const t of tests) {
    electricityUsd += t.electricityUsd;
    if (t.cloudEquivUsd !== undefined) {
      pricedRuns++;
      cloudEquivUsd += t.cloudEquivUsd;
      pricedElectricityUsd += t.electricityUsd;
    }
  }
  return {
    electricityUsd,
    pricedElectricityUsd,
    cloudEquivUsd,
    savedUsd: cloudEquivUsd - pricedElectricityUsd,
    pricedRuns,
    unpricedRuns: tests.length - pricedRuns,
  };
}

/** The A/B coverage proof: sample the selection under each required tag set and count the picks. Every eligible
 *  tool must be reachable, and nothing outside the filter may be picked. */
export function abCoverage(store: ToolStore, requirements: { kind: "llm" | "decision"; requires: string[] }[], draws = 300, random: () => number = Math.random) {
  return requirements.map(({ kind, requires }) => {
    const eligible = store.tools.filter((t) => t.enabled && t.kind === kind && requires.every((r) => t.tags.includes(r)));
    const counts: Record<string, number> = {};
    const reached = new Set<string>();
    if (eligible.length) {
      for (let i = 0; i < draws; i++) {
        const tool = select(store, kind, { requires, mode: "ab", random });
        counts[tool.name] = (counts[tool.name] ?? 0) + 1;
        reached.add(tool.name);
      }
    }
    const eligibleNames = new Set(eligible.map((t) => t.name));
    return {
      kind,
      requires,
      counts,
      reachable: eligible.map((t) => t.name).filter((n) => reached.has(n)),
      leaked: [...reached].filter((n) => !eligibleNames.has(n)),
    };
  });
}

export interface ZeroDeps {
  discover: () => Promise<MeshModelDiscovery[]>;
  /** Ask the user. Gets the candidates and the auto-selection; returns the chosen flags. */
  choose: (candidates: Candidate[], defaults: boolean[]) => Promise<boolean[]>;
  log: (line: string) => void;
  settings?: CostSettings;
  /** Optional cloud catalog. Its models are recorded as disabled tools, so the cost comparison has its twins. */
  cloud?: { models: () => CatalogModel[]; address: string };
}

export interface ZeroReport {
  at: number;
  mesh: { host: string; address?: string; models: number; error?: string }[];
  selected: string[];
  tests: ModelTest[];
  allTested: boolean;
  realized: RealizedCost;
  ab: ReturnType<typeof abCoverage>;
  selectionMode: "ab";
}

/** The whole bootstrap. Orchestration over injected discovery, dialog and logging, so the CLI and the offline
 *  eval run the same code. */
export async function bootstrap(deps: ZeroDeps): Promise<ZeroReport> {
  const { log } = deps;
  const settings = deps.settings ?? DEFAULT_SETTINGS;

  // 1. Discover the whole mesh. Hosts with no model server are listed with the reason.
  const discovered = await deps.discover();
  log("== mesh");
  for (const d of discovered) {
    const status = d.models.length ? `${d.models.length} local model(s)` : d.error?.startsWith("access denied") ? d.error : d.error ?? "no model server";
    log(`  ${d.host.name.padEnd(14)} ${status}`);
  }
  const mesh = discovered.map((d) => ({ host: d.host.name, address: d.address, models: d.models.length, error: d.models.length ? undefined : d.error }));

  // 2. The dialog: every discovered local model, pre-checked. The answer decides what gets enabled.
  const candidates = candidatesOf(discovered);
  if (candidates.length === 0) throw new Error("zero: no local models found on any mesh host");
  const chosen = await deps.choose(candidates, autoSelection(candidates));
  const picked = candidates.filter((_, i) => chosen[i]);
  if (picked.length === 0) throw new Error("zero: nothing selected");
  log(`\n== enabling ${picked.length} of ${candidates.length} model(s)`);

  // 3. Record the discovery, and the cloud catalog if one was given. Nothing cloud is enabled here.
  const store = loadStore();
  for (const d of discovered) {
    if (!d.address) continue;
    store.hosts = [...store.hosts.filter((h) => h.host !== d.host.name), { host: d.host.name, address: d.address, lastProbeAt: Date.now(), error: d.error }];
    for (const m of d.models) upsertMeshTool(store, d.host.name, d.address, m);
  }
  if (deps.cloud) {
    try {
      const r = syncCloudTools(store, deps.cloud.models(), deps.cloud.address);
      log(`  cloud catalog: ${r.added} added, ${r.refreshed} refreshed (disabled until enabled)`);
    } catch (e) {
      log(`  cloud catalog unavailable (${String((e as Error).message).slice(0, 120)}); continuing with local models`);
    }
  }

  // 4. Enable the selection; every other local tool is switched off, so an earlier run cannot leave a model live.
  const enabled: ModelTool[] = [];
  for (const t of store.tools.filter((t) => t.source === "mesh" && t.enabled)) {
    if (!picked.some((c) => c.host === t.host && c.id === t.model)) setEnabled(store, t.name, false);
  }
  for (const c of picked) {
    const tool = store.tools.find((t) => t.host === c.host && t.model === c.id && t.source === "mesh");
    if (!tool) throw new Error(`zero: ${c.host}/${c.id} was discovered but has no tool record`);
    setEnabled(store, tool.name, true);
    enabled.push(tool);
  }
  saveStore(store);

  log("\n== testing (live, local only)");
  const tests: ModelTest[] = [];
  for (const [i, tool] of enabled.entries()) {
    const t = await testTool(store, tool, settings);
    tests.push(t);
    const cost = t.cloudEquivUsd === undefined ? "cloud: no priced twin" : `cloud-equiv $${t.cloudEquivUsd.toFixed(6)} vs electricity $${t.electricityUsd.toFixed(6)}`;
    log(`  ${t.ok ? "✓" : "✗"} [${i + 1}/${enabled.length}] ${tool.host}/${tool.model}  ${(t.ms / 1000).toFixed(1)}s  ${t.sample || t.error || ""}  (${cost})`);
  }
  saveStore(store);

  // 5. Realized cost, and the A/B proof. Neither counts opportunity cost.
  const realized = realizedCost(tests);
  const ab = abCoverage(store, [
    { kind: "decision", requires: kindTags("decision") },
    { kind: "llm", requires: kindTags("llm") },
  ]);
  log("\n== realized cost (electricity only; wait time not counted)");
  log(`  priced runs (${realized.pricedRuns}, a cloud twin exists): electricity $${realized.pricedElectricityUsd.toFixed(6)}  vs  cloud $${realized.cloudEquivUsd.toFixed(6)}  →  saved $${realized.savedUsd.toFixed(6)}`);
  log(`  all runs (${tests.length}): electricity $${realized.electricityUsd.toFixed(6)}  (${realized.unpricedRuns} run(s) have no priced cloud twin, so they are not compared)`);
  log("\n== A/B selection (300 draws per required tag set)");
  for (const row of ab) {
    const parts = Object.entries(row.counts).map(([name, n]) => `${name}=${n}`).join("  ");
    log(`  ${row.kind} requires [${row.requires.join(", ")}]: ${row.reachable.length} reachable, ${row.leaked.length} leaked  ${parts}`);
  }

  // 6. The verdict. A failed test keeps its tool enabled and blocks "systems a go".
  const allTested = tests.every((t) => t.ok) && ab.every((r) => r.leaked.length === 0 && r.reachable.length > 0);
  store.selectionMode = "ab";
  saveStore(store);
  log(`\nselection mode: ab (A/B random, filtered by the required tags)`);
  if (allTested) {
    log("all models tested, systems a go.");
  } else {
    const failed = tests.filter((t) => !t.ok).map((t) => t.model);
    log(`NOT READY: ${failed.length ? `failed: ${failed.join(", ")}` : "A/B coverage check failed"}`);
  }

  const report: ZeroReport = { at: Date.now(), mesh, selected: picked.map((c) => `${c.host}/${c.id}`), tests, allTested, realized, ab, selectionMode: "ab" };
  notifyReady({
    at: report.at,
    kind: "ready",
    message: allTested
      ? `zero bootstrap: ${tests.length} local model(s) enabled and tested across ${mesh.filter((m) => m.models).length} host(s); A/B mode`
      : `zero bootstrap: not ready (${tests.filter((t) => !t.ok).length} failed)`,
    validated: { tests: tests.length, passed: tests.filter((t) => t.ok).length, realized, selectionMode: "ab" },
  });
  return report;
}
