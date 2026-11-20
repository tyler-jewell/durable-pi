// Apples-to-apples profile: for every model family that has an enabled mesh tool AND a priced cloud tool of the
// same kind, send the same prompt to both and compare tokens, latency and cost. Nothing is named here: the pairs
// come from the tool store (discover_models and the zero bootstrap fill it).
//
//   npx tsx scripts/profile-models.mts            # runs the pairs the store holds
//
// Cloud calls cost money (priced from the catalog, per token). Local calls cost electricity, marginal only.
// The report prints the exact names it used on each side, because a family can differ in quantization.
import { loadStore, type ModelTool, type ToolStore } from "../src/tool-store.js";
import { callChat, callDecision } from "../src/model-tools.js";
import { marginalElectricityUsd, DEFAULT_SETTINGS } from "../src/meter.js";
import { tokenCostUsd } from "../src/cloud-catalog.js";
import type { DecisionQuestion } from "../src/models.js";

const LLM_PROMPT = [{ role: "user" as const, content: "Explain the difference between a process and a thread, in under 60 words." }];
const DECISION_QUESTION: Record<string, DecisionQuestion> = {
  verdict: { type: "choice", instructions: "Is the change ready to ship?", criteria: { approve: "ready", revise: "needs work", reject: "broken" } },
};
const STATE = { plan: "add a status page", facts: "tests pass; the build is green" };

interface Pair {
  family: string;
  kind: "llm" | "decision";
  local: ModelTool;
  cloud: ModelTool;
}

/** Families with an enabled mesh tool and a priced cloud tool of the same kind. */
export function pairsOf(store: ToolStore): Pair[] {
  const pairs: Pair[] = [];
  for (const local of store.tools.filter((t) => t.enabled && t.source === "mesh")) {
    const cloud = store.tools.find((t) => t.source === "cloud" && t.kind === local.kind && t.family === local.family && t.pricing);
    if (cloud) pairs.push({ family: local.family, kind: local.kind, local, cloud });
  }
  return pairs;
}

async function run(store: ToolStore, tool: ModelTool): Promise<{ ms: number; inToks: number; outToks: number; truncated: boolean }> {
  const t0 = Date.now();
  if (tool.kind === "llm") {
    const r = await callChat(store, tool, LLM_PROMPT);
    return { ms: Date.now() - t0, inToks: r.inToks, outToks: r.outToks, truncated: r.truncated };
  }
  const r = await callDecision(store, tool, STATE, DECISION_QUESTION);
  return { ms: Date.now() - t0, inToks: r.inToks, outToks: r.outToks, truncated: false };
}

async function main() {
  const store = loadStore();
  const pairs = pairsOf(store);
  if (pairs.length === 0) {
    console.log("profile: no family has both an enabled mesh tool and a priced cloud tool. Run discover_models, then enable the local model.");
    return;
  }
  console.log(`profile: ${pairs.length} pair(s)\n`);
  for (const p of pairs) {
    console.log(`${p.kind} · family ${p.family}`);
    // One failing side (a retired catalog model, an offline host) is reported and the profile carries on.
    try {
      const l = await run(store, p.local);
      const cost = marginalElectricityUsd(l.ms, DEFAULT_SETTINGS);
      const cut = l.truncated ? "  TRUNCATED at the output limit" : "";
      console.log(`  local  ${p.local.model.padEnd(44)} ${(l.ms / 1000).toFixed(2)}s  in ${l.inToks} out ${l.outToks}  electricity $${cost.toFixed(6)}${cut}`);
    } catch (e) {
      console.log(`  local  ${p.local.model}  FAILED: ${String((e as Error).message).slice(0, 140)}`);
    }
    try {
      const c = await run(store, p.cloud);
      const cost = tokenCostUsd(p.cloud.pricing, c.inToks, c.outToks) ?? 0;
      const cut = c.truncated ? "  TRUNCATED at the output limit" : "";
      console.log(`  cloud  ${p.cloud.model.padEnd(44)} ${(c.ms / 1000).toFixed(2)}s  in ${c.inToks} out ${c.outToks}  billed $${cost.toFixed(6)}${cut}`);
    } catch (e) {
      console.log(`  cloud  ${p.cloud.model}  FAILED: ${String((e as Error).message).slice(0, 140)}`);
    }
    console.log("");
  }
}

if (process.argv[1]?.endsWith("profile-models.mts")) await main();
