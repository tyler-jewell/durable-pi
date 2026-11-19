// Prove the unified model surface: four calls through the MCP capability registry —
// local LLM, cloud (Workers AI) LLM, local decision, cloud decision — with a profile each.
//   CLOUDFLARE_API_KEY=<key> LLAMA_BASE_URL=<tunnel> npx tsx scripts/profile-models.mts
import { enableCapability, loadRegistry, runDecision, runLlm, type Capability } from "../src/capabilities.js";

const CF_KEY = process.env.CLOUDFLARE_API_KEY ?? "";
const reg = loadRegistry();
for (const c of reg.capabilities.filter((x) => x.host === "cloudflare")) {
  if (c.state !== "enabled") enableCapability(reg, c.id, { inputs: [{ name: "api_key", value: CF_KEY }] });
}

const keyOf = (c: Capability) => c.inputs.find((i) => i.secret)?.value;
const pick = (kind: "llm" | "decision", cloud: boolean) => {
  const c = reg.capabilities.filter((x) => x.state === "enabled" && x.kind === kind && (cloud ? x.host === "cloudflare" : x.host !== "cloudflare"))[0];
  if (!c) throw Error(`no ${cloud ? "cloud" : "local"} ${kind} capability enabled`);
  return c;
};

const rows: { call: string; transport: string; model: string; ms: number; out: string }[] = [];
async function profile(call: string, cap: Capability, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  rows.push({ call, transport: cap.transport, model: cap.model, ms, out: JSON.stringify(out) });
}

const llmLocal = pick("llm", false);
const llmCloud = pick("llm", true);
const decLocal = pick("decision", false);
const decCloud = pick("decision", true);

const llmMsg = [{ role: "user" as const, content: "Reply with exactly: OK" }];
const decState = { plan: "build a todo app", facts: "typecheck and build pass" };
const decQ = { verdict: { type: "choice" as const, instructions: "Should this app ship?", criteria: { approve: "ship", revise: "fix", reject: "block" } } };

await profile("1 · LLM · local", llmLocal, () => runLlm(llmLocal.address, llmLocal.model, llmMsg, { transport: llmLocal.transport, timeoutMs: 180_000 }));
await profile("2 · LLM · cloud", llmCloud, () => runLlm(llmCloud.address, llmCloud.model, llmMsg, { transport: llmCloud.transport, apiKey: keyOf(llmCloud), timeoutMs: 60_000 }));
await profile("3 · Decision · local", decLocal, () => runDecision(decLocal.address, decLocal.model, decState, decQ, { transport: decLocal.transport, timeoutMs: 60_000 }));
await profile("4 · Decision · cloud", decCloud, () => runDecision(decCloud.address, decCloud.model, decState, decQ, { transport: decCloud.transport, apiKey: keyOf(decCloud), timeoutMs: 60_000 }));

console.log("\nPROFILE");
for (const r of rows) {
  console.log(`  ${r.call.padEnd(18)} ${r.transport.padEnd(21)} ${r.model.padEnd(42)} ${String(r.ms).padStart(6)} ms  ${r.out.slice(0, 90)}`);
}
