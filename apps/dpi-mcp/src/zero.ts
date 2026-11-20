// The zero bootstrap: take a bare system to a working local model surface in one run.
//
//   discover every mesh host (mesh.json, Cloudflare Tunnel + Access)
//   → choose which local models to enable (the dialog; defaults to all, pre-checked)
//   → enable each as a capability (autoEnable) and test it live with a real call
//   → report realized cost (marginal electricity, vs the same tokens priced on cloud)
//   → prove the A/B selection covers every required-purpose candidate
//   → "all models tested, systems a go", with the default mode set to A/B random.
//
// Validation runs on local models only. A cloud twin is priced from its catalog rate and the tokens the
// local run used. It is never called, so zero cloud spend is possible here. Opportunity cost (wait time)
// is deliberately NOT counted: the report shows realized spend only.
import { disableCapability, loadRegistry, recommendCapability, enableCapability, runDecision, runLlm, saveRegistry, selectCapability, type Capability, type CapabilityKind, type CapabilityRegistry, type DecisionQuestion } from "./capabilities.js";
import type { MeshModelDiscovery } from "./mesh.js";
import { DEFAULT_SETTINGS, loadMeter, marginalElectricityUsd, recordUsage, type CostSettings } from "./meter.js";
import { syncCloudCapabilities, tokenCostUsd, type CatalogModel } from "./cloud-catalog.js";
import { notifyReady } from "./notify.js";

export interface Candidate {
  host: string;
  address: string;
  id: string;
  kind: CapabilityKind;
}

/** Every discovered local model, in host order. A host with no model contributes nothing. */
export function candidatesOf(discovered: MeshModelDiscovery[]): Candidate[] {
  return discovered.flatMap((d) => (d.address ? d.models.map((m) => ({ host: d.host.name, address: d.address!, id: m.id, kind: m.kind })) : []));
}

/**
 * Apply the user's answer to the checklist. `defaults` is the pre-checked state (the auto-selection).
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

/** The auto-selection policy. Every discovered local model is pre-checked: the decision models for
 *  jev-quality, and every chat model so the A/B selection has a real candidate set. The user can
 *  deselect any of them in the dialog before submitting. */
export function autoSelection(candidates: Candidate[]): boolean[] {
  return candidates.map(() => true);
}

/** The purposes a candidate serves once enabled. */
export function purposeOf(kind: CapabilityKind): string[] {
  return kind === "decision" ? ["jev-quality"] : ["agent"];
}

export interface ModelTest {
  capability: string;
  host: string;
  model: string;
  kind: CapabilityKind;
  ok: boolean;
  ms: number;
  inToks: number;
  outToks: number;
  /** Marginal electricity for this run (realized, excludes opportunity cost). */
  electricityUsd: number;
  /** The same tokens priced on the cloud twin in the registry. Undefined when no priced twin exists. */
  cloudEquivUsd?: number;
  cloudModel?: string;
  sample: string;
  error?: string;
}

const PROBE_QUESTION: Record<string, DecisionQuestion> = {
  verdict: { type: "choice", instructions: "Is the system ready to run?", criteria: { approve: "yes, ready", revise: "unsure", reject: "no" } },
};
const PROBE_STATE = { plan: "zero bootstrap probe", facts: "the model server answered /health" };

/** The cloud twin: a cloud capability of the same kind and family, priced from the catalog. */
export function cloudTwinOf(reg: CapabilityRegistry, cap: Capability): Capability | undefined {
  return reg.capabilities.find((c) => c.host === "cloudflare" && c.kind === cap.kind && c.family === cap.family);
}

/** Run one live call on an enabled local capability and record it in the meter. */
export async function testCapability(reg: CapabilityRegistry, cap: Capability, settings: CostSettings = DEFAULT_SETTINGS): Promise<ModelTest> {
  const base = { capability: cap.id, host: cap.host, model: cap.model, kind: cap.kind };
  const t0 = Date.now();
  let ok = false;
  let sample = "";
  let inToks = 0;
  let outToks = 0;
  let error: string | undefined;
  try {
    if (cap.kind === "decision") {
      const r = await runDecision(cap.address, cap.model, PROBE_STATE, PROBE_QUESTION, { transport: cap.transport, timeoutMs: 120_000, contextWindow: cap.contextWindow });
      const answer = r.answers.verdict;
      ok = answer?.type === "choice" && typeof answer.choice === "string";
      sample = answer?.type === "choice" ? `${answer.choice} (${(answer.confidence ?? 0).toFixed(2)})` : JSON.stringify(answer);
      inToks = r.inToks;
      outToks = r.outToks;
    } else {
      const r = await runLlm(cap.address, cap.model, [{ role: "user", content: "Reply with exactly: OK" }], { transport: cap.transport, timeoutMs: 180_000, contextWindow: cap.contextWindow });
      ok = /\bOK\b/i.test(r.text);
      sample = r.text.trim().slice(0, 60);
      inToks = r.inToks;
      outToks = r.outToks;
    }
  } catch (e) {
    error = String((e as Error).message).slice(0, 200);
  }
  const ms = Date.now() - t0;
  // Record the run. Local calls carry their interval, so the meter's kWh stays right.
  recordUsage(loadMeter(), { startedAt: t0, endedAt: t0 + ms, model: cap.family, kind: cap.kind, transport: cap.transport, inToks, outToks, costUsd: 0 });

  const twin = cloudTwinOf(reg, cap);
  const cloudEquivUsd = tokenCostUsd(twin?.pricing, inToks, outToks);
  return {
    ...base,
    ok: ok && !error,
    ms,
    inToks,
    outToks,
    electricityUsd: marginalElectricityUsd(ms, settings),
    cloudEquivUsd,
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
  /** Savings over those priced runs: cloud-equivalent minus the electricity those same runs used. */
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

/** A/B coverage proof: sample the default selection under each required purpose and count the picks.
 *  Every candidate that matches the filter must be reachable, and nothing outside it may be picked. */
export function abCoverage(reg: CapabilityRegistry, purposes: string[][], draws = 300): { required: string[]; counts: Record<string, number>; reachable: string[]; leaked: string[] }[] {
  return purposes.map((required) => {
    const kind = (["jev-quality"].some((p) => required.includes(p)) ? "decision" : "llm") as CapabilityKind;
    const eligible = reg.capabilities.filter((c) => c.state === "enabled" && c.kind === kind && c.host !== "cloudflare" && required.every((p) => c.purpose.includes(p)));
    const counts: Record<string, number> = {};
    const reached = new Set<string>();
    if (eligible.length) {
      for (let i = 0; i < draws; i++) {
        const cap = selectCapability(reg, kind, { required, mode: "ab" });
        counts[cap.id] = (counts[cap.id] ?? 0) + 1;
        reached.add(cap.id);
      }
    }
    const eligibleIds = new Set(eligible.map((c) => c.id));
    return {
      required,
      counts,
      reachable: eligible.map((c) => c.id).filter((id) => reached.has(id)),
      leaked: [...reached].filter((id) => !eligibleIds.has(id)),
    };
  });
}

export interface ZeroDeps {
  discover: () => Promise<MeshModelDiscovery[]>;
  /** Optional cloud catalog. When present, its models are recorded as recommended capabilities (never enabled),
   *  so the cost comparison has its twins. A failed read is logged and the run goes on with local models. */
  cloud?: { models: () => CatalogModel[]; address: string };
  /** Ask the user. Gets the candidates and the auto-selection; returns the chosen flags. */
  choose: (candidates: Candidate[], defaults: boolean[]) => Promise<boolean[]>;
  log: (line: string) => void;
  settings?: CostSettings;
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

/** The whole bootstrap. Pure orchestration over injected discovery, dialog and logging, so the CLI and the
 *  offline eval run exactly the same code. */
export async function bootstrap(deps: ZeroDeps): Promise<ZeroReport> {
  const { log } = deps;
  const settings = deps.settings ?? DEFAULT_SETTINGS;

  // 1. Discover the whole mesh. Hosts with no model server are still listed, with the reason.
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
  const defaults = autoSelection(candidates);
  const chosen = await deps.choose(candidates, defaults);
  const picked = candidates.filter((_, i) => chosen[i]);
  if (picked.length === 0) throw new Error("zero: nothing selected");
  log(`\n== enabling ${picked.length} of ${candidates.length} model(s)`);

  // 3. Enable each selection as a capability, then test it live. Local only: a cloud capability is never
  //    enabled or called here. The probe is the same for every model, so the results compare directly.
  const reg = loadRegistry();
  reg.hosts = [
    ...reg.hosts.filter((h) => !discovered.some((d) => d.host.name === h.host)),
    ...discovered.filter((d) => d.models.length && d.address).map((d) => ({ host: d.host.name, address: d.address!, health: "online" as const, reachable: true, models: d.models, discoveredAt: Date.now() })),
  ];
  if (deps.cloud) {
    try {
      const r = syncCloudCapabilities(reg, deps.cloud.models(), deps.cloud.address);
      log(`  cloud catalog: ${r.added} added, ${r.refreshed} refreshed (recommended only, none enabled)`);
    } catch (e) {
      log(`  cloud catalog unavailable (${String((e as Error).message).slice(0, 120)}); continuing with local models`);
    }
  }
  const enabled: Capability[] = [];
  for (const c of picked) {
    const cap = recommendCapability(reg, { host: c.host, model: c.id, description: `Local ${c.kind} model enabled by the zero bootstrap`, purpose: purposeOf(c.kind) });
    enableCapability(reg, cap.id, { autoEnable: true });
    enabled.push(cap);
  }
  // The dialog answer defines what is on. A local capability left unchecked is switched off, so a model
  // enabled in an earlier run cannot stay live after the user unchecked it.
  const keep = new Set(enabled.map((c) => c.id));
  for (const c of reg.capabilities) {
    if (c.host !== "cloudflare" && c.state === "enabled" && !keep.has(c.id)) disableCapability(reg, c.id);
  }
  saveRegistry(reg);

  log("\n== testing (live, local only)");
  const tests: ModelTest[] = [];
  for (const [i, cap] of enabled.entries()) {
    const t = await testCapability(reg, cap, settings);
    tests.push(t);
    const mark = t.ok ? "✓" : "✗";
    const cost = t.cloudEquivUsd === undefined ? "cloud: no priced twin" : `cloud-equiv $${t.cloudEquivUsd.toFixed(6)} vs electricity $${t.electricityUsd.toFixed(6)}`;
    log(`  ${mark} [${i + 1}/${enabled.length}] ${cap.host}/${cap.model}  ${(t.ms / 1000).toFixed(1)}s  ${t.sample || t.error || ""}  (${cost})`);
  }
  saveRegistry(reg);

  // 4. Realized cost, and the A/B proof. Neither counts opportunity cost.
  const realized = realizedCost(tests);
  const ab = abCoverage(reg, [["jev-quality"], ["agent"]]);
  saveRegistry(reg);
  log("\n== realized cost (electricity only; wait time not counted)");
  log(`  priced runs (${realized.pricedRuns}, a cloud twin exists): electricity $${realized.pricedElectricityUsd.toFixed(6)}  vs  cloud $${realized.cloudEquivUsd.toFixed(6)}  →  saved $${realized.savedUsd.toFixed(6)}`);
  log(`  all runs (${tests.length}): electricity $${realized.electricityUsd.toFixed(6)}  (${realized.unpricedRuns} run(s) have no priced cloud twin, so they are not compared)`);
  log("\n== A/B selection (300 draws per required purpose)");
  for (const row of ab) {
    const parts = Object.entries(row.counts).map(([id, n]) => `${id}=${n}`).join("  ");
    log(`  required [${row.required.join(", ")}]: ${row.reachable.length} reachable, ${row.leaked.length} leaked  ${parts}`);
  }

  // 5. The verdict. A model that failed its test keeps its capability but blocks "systems a go".
  const allTested = tests.every((t) => t.ok) && ab.every((r) => r.leaked.length === 0 && r.reachable.length > 0);
  reg.selectionMode = "ab";
  saveRegistry(reg);
  log(`\nselection mode: ab (A/B random, filtered by the required capabilities)`);
  if (allTested) {
    log("all models tested, systems a go.");
  } else {
    const failed = tests.filter((t) => !t.ok).map((t) => t.model);
    log(`NOT READY: ${failed.length ? `failed: ${failed.join(", ")}` : "A/B coverage check failed"}`);
  }

  const report: ZeroReport = { at: Date.now(), mesh, selected: picked.map((c) => `${c.host}/${c.id}`), tests, allTested, realized, ab, selectionMode: "ab" };
  notifyReady({
    at: report.at,
    kind: "capability-ready",
    message: allTested
      ? `zero bootstrap: ${tests.length} local model(s) enabled and tested across ${mesh.filter((m) => m.models).length} host(s); A/B mode`
      : `zero bootstrap: not ready (${tests.filter((t) => !t.ok).length} failed)`,
    validated: { tests: tests.length, passed: tests.filter((t) => t.ok).length, realized, selectionMode: "ab" },
  });
  return report;
}
