// Apples-to-apples + cost profile: the SAME model on local (Studio) and cloud (Workers AI),
// same prompt and parameters, capturing tokens and billable cost.
//
//   CLOUDFLARE_API_KEY=<key> CLOUDFLARE_ACCOUNT_ID=<id> npx tsx scripts/profile-models.mts
//
// Pair 1 (LLM):       gpt-oss-20b  — local MXFP4 vs @cf/openai/gpt-oss-20b
// Pair 2 (decision):  Clef-Flash   — local Q4_K_M vs @cf/cloudflare/clef-flash
// Cost: Workers AI prices (USD per M tokens) are billing facts from the CF catalog;
// local marginal cost is $0 — the Studio is a fixed-cost box (electricity is estimated).

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const CF_KEY = process.env.CLOUDFLARE_API_KEY ?? "";
const LOCAL_BASE = (process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}`;

// Billing facts (Workers AI catalog, 19 Nov 2026): $ per million tokens.
const PRICE = {
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
  "@cf/cloudflare/clef-flash": { in: 0.038, out: 0 },
} as const;

const ELECTRICITY_USD_PER_KWH = 0.15; // rough US average
const STUDIO_WATTS = 80; // M1 Max under Metal inference, rough

type Row = { call: string; transport: string; model: string; ms: number; inToks: number; outToks: number; cost: number; coldMs?: number };
const rows: Row[] = [];

async function post(url: string, body: unknown, apiKey?: string): Promise<{ ms: number; data: any }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw Error(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { ms, data: await res.json() };
}

// --- LLM, same prompt + params on both ---
const llmPrompt = [{ role: "user", content: "Explain the difference between a process and a thread, in under 60 words." }];
const llmParams = { temperature: 0, max_tokens: 64 };

// Warm the local model first: the Studio router serves one GGUF at a time (--models-max 1),
// so a cold call pays a load/swap. We discard the warm-up and measure the warm generation.
const llmWarmup = await post(`${LOCAL_BASE}/v1/chat/completions`, { model: "gpt-oss-20b-MXFP4", messages: [{ role: "user", content: "hi" }], max_tokens: 4, temperature: 0 });
const llmLocal = await post(`${LOCAL_BASE}/v1/chat/completions`, { model: "gpt-oss-20b-MXFP4", messages: llmPrompt, ...llmParams });
const llmLocalU = llmLocal.data.usage ?? {};
rows.push({ call: "LLM · local (warm)", transport: "openai-compat", model: "gpt-oss-20b-MXFP4", ms: llmLocal.ms, inToks: llmLocalU.prompt_tokens ?? 0, outToks: llmLocalU.completion_tokens ?? 0, cost: 0, coldMs: llmWarmup.ms });

const llmCf = await post(`${CF_BASE}/ai/v1/chat/completions`, { model: "@cf/openai/gpt-oss-20b", messages: llmPrompt, ...llmParams }, CF_KEY);
const llmCfU = llmCf.data.usage ?? {};
rows.push({ call: "LLM · cloud", transport: "cloudflare-workers-ai", model: "@cf/openai/gpt-oss-20b", ms: llmCf.ms, inToks: llmCfU.prompt_tokens ?? 0, outToks: llmCfU.completion_tokens ?? 0, cost: 0 });

// --- Decision, same state + questions on both ---
const decState = { plan: "build a todo app", facts: "typecheck and build pass" };
const decQ = { verdict: { type: "choice", instructions: "Should this app ship?", criteria: { approve: "ship", revise: "fix", reject: "block" } } };

const decWarmup = await post(`${LOCAL_BASE}/v1/systemone`, { model: "Clef-Flash-Q4_K_M", state: { x: 1 }, questions: { q: { type: "noul", instructions: "return 0" } } });
const decLocal = await post(`${LOCAL_BASE}/v1/systemone`, { model: "Clef-Flash-Q4_K_M", state: decState, questions: decQ });
const decLocalU = decLocal.data.usage ?? {};
rows.push({ call: "Decision · local (warm)", transport: "openai-compat", model: "Clef-Flash-Q4_K_M", ms: decLocal.ms, inToks: decLocalU.input_tokens ?? 0, outToks: decLocalU.output_tokens ?? 0, cost: 0, coldMs: decWarmup.ms });

const decCf = await post(`${CF_BASE}/ai/run`, { model: "@cf/cloudflare/clef-flash", input: { state: decState, questions: decQ } }, CF_KEY);
const decCfU = decCf.data?.result?.usage ?? {};
rows.push({ call: "Decision · cloud", transport: "cloudflare-workers-ai", model: "@cf/cloudflare/clef-flash", ms: decCf.ms, inToks: decCfU.input_tokens ?? 0, outToks: decCfU.output_tokens ?? 0, cost: 0 });

// --- cost ---
for (const r of rows) {
  if (r.transport === "cloudflare-workers-ai") {
    const p = PRICE[r.model as keyof typeof PRICE] ?? { in: 0, out: 0 };
    r.cost = (r.inToks * p.in + r.outToks * p.out) / 1_000_000;
  }
}

const cents = (n: number) => `$${n.toFixed(6)} (${(n * 100).toFixed(5)}¢)`;
console.log("\nAPPLES-TO-APPLES PROFILE (same model + params, local vs cloud)");
console.log("  call                   transport               model                                ms      in-tok  out-tok  billable cost");
for (const r of rows) {
  const cold = r.coldMs !== undefined ? `  (cold load/swap ${r.coldMs} ms)` : "";
  console.log(
    `  ${r.call.padEnd(22)} ${r.transport.padEnd(23)} ${r.model.padEnd(38)} ${String(r.ms).padStart(6)}  ${String(r.inToks).padStart(6)}  ${String(r.outToks).padStart(6)}  ${r.transport === "cloudflare-workers-ai" ? cents(r.cost) : "$0 (marginal)"}${cold}`,
  );
}
const localEnergyKwh = rows.filter((r) => r.transport === "openai-compat").reduce((a, r) => a + (STUDIO_WATTS * r.ms) / 3_600_000_000, 0); // W·ms → kWh
console.log(`\nLocal electricity (estimate, warm generation only): ${(localEnergyKwh * 1000).toFixed(3)} Wh ≈ ${cents(localEnergyKwh * ELECTRICITY_USD_PER_KWH)} across the two warm local calls (${STUDIO_WATTS} W · ${ELECTRICITY_USD_PER_KWH.toFixed(2)} $/kWh).`);
console.log(`Cloud billable total: ${cents(rows.filter((r) => r.transport === "cloudflare-workers-ai").reduce((a, r) => a + r.cost, 0))}.`);
