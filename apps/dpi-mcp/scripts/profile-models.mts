// Apples-to-apples profile: for every model family that has BOTH an enabled local capability and a priced cloud
// twin in the registry, send the same prompt to both and compare tokens, latency and cost. Nothing is named here:
// the pairs come from discovery (see `discover_cloud` and the zero bootstrap).
//
//   npx tsx scripts/profile-models.mts            # runs the pairs the registry holds
//
// Cloud calls cost money (priced from the catalog, per token). Local calls cost electricity, marginal only.
// The report prints the exact names it used on each side, because a family can differ in quantization.

import { loadRegistry, runDecision, runLlm, type Capability, type CapabilityRegistry, type DecisionQuestion } from "../src/capabilities.js";
import { marginalElectricityUsd, DEFAULT_SETTINGS } from "../src/meter.js";
import { tokenCostUsd } from "../src/cloud-catalog.js";

const LLM_PROMPT = [{ role: "user" as const, content: "Explain the difference between a process and a thread, in under 60 words." }];
const DECISION_QUESTION: Record<string, DecisionQuestion> = {
  verdict: { type: "choice", instructions: "Is the change ready to ship?", criteria: { approve: "ready", revise: "needs work", reject: "broken" } },
};
const STATE = { plan: "add a status page", facts: "tests pass; the build is green" };

interface Pair {
  family: string;
  kind: "llm" | "decision";
  local: Capability;
  cloud: Capability;
}

/** Families with an enabled local capability and a priced cloud twin of the same kind. */
export function pairsOf(reg: CapabilityRegistry): Pair[] {
  const pairs: Pair[] = [];
  for (const local of reg.capabilities.filter((c) => c.state === "enabled" && c.host !== "cloudflare")) {
    const cloud = reg.capabilities.find((c) => c.host === "cloudflare" && c.kind === local.kind && c.family === local.family && c.pricing);
    if (cloud) pairs.push({ family: local.family, kind: local.kind, local, cloud });
  }
  return pairs;
}

async function run(cap: Capability): Promise<{ ms: number; inToks: number; outToks: number; truncated: boolean }> {
  // A cloud twin takes its key from the environment (CLOUDFLARE_API_KEY) unless the capability stores one.
  const stored = cap.inputs.find((i) => i.secret)?.value;
  const apiKey = stored ?? (cap.transport === "cloudflare-workers-ai" ? process.env.CLOUDFLARE_API_KEY : undefined);
  const opts = { transport: cap.transport, apiKey };
  const t0 = Date.now();
  const r =
    cap.kind === "llm"
      ? await runLlm(cap.address, cap.model, LLM_PROMPT, opts)
      : await runDecision(cap.address, cap.model, STATE, DECISION_QUESTION, opts);
  return { ms: Date.now() - t0, inToks: r.inToks, outToks: r.outToks, truncated: "truncated" in r ? Boolean(r.truncated) : false };
}

async function main() {
  const reg = loadRegistry();
  const pairs = pairsOf(reg);
  if (pairs.length === 0) {
    console.log("profile: no family has both an enabled local capability and a priced cloud twin. Run discover_cloud, then enable the local model.");
    return;
  }
  console.log(`profile: ${pairs.length} pair(s)\n`);
  for (const p of pairs) {
    console.log(`${p.kind} · family ${p.family}`);
    // One failing side (a retired catalog model, an offline host) is reported and the profile carries on.
    try {
      const l = await run(p.local);
      const localCost = marginalElectricityUsd(l.ms, DEFAULT_SETTINGS);
      const cut = l.truncated ? "  TRUNCATED at the output limit" : "";
      console.log(`  local  ${p.local.model.padEnd(44)} ${(l.ms / 1000).toFixed(2)}s  in ${l.inToks} out ${l.outToks}  electricity $${localCost.toFixed(6)}${cut}`);
    } catch (e) {
      console.log(`  local  ${p.local.model}  FAILED: ${String((e as Error).message).slice(0, 140)}`);
    }
    try {
      const c = await run(p.cloud);
      const cloudCost = tokenCostUsd(p.cloud.pricing, c.inToks, c.outToks) ?? 0;
      const cut = c.truncated ? "  TRUNCATED at the output limit" : "";
      console.log(`  cloud  ${p.cloud.model.padEnd(44)} ${(c.ms / 1000).toFixed(2)}s  in ${c.inToks} out ${c.outToks}  billed $${cloudCost.toFixed(6)}${cut}`);
    } catch (e) {
      console.log(`  cloud  ${p.cloud.model}  FAILED: ${String((e as Error).message).slice(0, 140)}`);
    }
    console.log("");
  }
}

if (process.argv[1]?.endsWith("profile-models.mts")) await main();
