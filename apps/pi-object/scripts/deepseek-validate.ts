// Validates the DeepSeek cost logic against DeepSeek's own billing. An independent oracle: it calls the API
// directly (no agent, no Durable Object), records every response's `usage`, prices it with our price book,
// and compares the total with the change in `GET /user/balance` (the provider's ground truth).
//
//   npx tsx scripts/deepseek-validate.ts --calls 120 --model deepseek-v4-pro
//
// Spends real money. Balance is reported to 2 decimals, so the comparison has a resolution of about $0.02:
// it catches wrong rates, a missing peak/off-peak rule, or a cache miscount, but not sub-cent error.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isDeepSeekPeak, PRICES } from "../src/cost/prices.js";

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] ?? "true"]] : acc), []));
const MODEL = (args.model ?? "deepseek-v4-pro") as keyof typeof PRICES.deepseek;
const CALLS = Number(args.calls ?? 120);
const CONCURRENCY = Number(args.concurrency ?? 40);
const MAX_TOKENS = Number(args["max-tokens"] ?? 1200);

const apiKey = process.env.DEEPSEEK_API_KEY ?? JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8")).deepseek?.key;
if (!apiKey) throw new Error("no DeepSeek key: set DEEPSEEK_API_KEY or log in with pi");
const BASE = "https://api.deepseek.com";

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

async function balance(): Promise<{ currency: string; total: number; at: number }> {
  const res = await fetch(`${BASE}/user/balance`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`balance HTTP ${res.status}`);
  const body = (await res.json()) as { balance_infos: Array<{ currency: string; total_balance: string }> };
  const info = body.balance_infos[0];
  return { currency: info.currency, total: Number(info.total_balance), at: Date.now() };
}

// A long shared prefix so DeepSeek's context cache is exercised: the first call misses, later calls hit.
const SHARED = Array.from({ length: 600 }, (_, i) => `Reference note ${i}: durable objects keep state close to compute and checkpoint every step.`).join("\n");

async function call(i: number): Promise<{ usage: Usage; at: number; peak: boolean }> {
  const at = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SHARED },
        { role: "user", content: `Write a 600-word essay, number ${i}, on checkpointing agents. Be specific.` },
      ],
      max_tokens: MAX_TOKENS,
      stream: false,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`call ${i}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { usage: Usage };
  return { usage: body.usage, at, peak: isDeepSeekPeak(at) };
}

async function main() {
  const before = await balance();
  const started = Date.now();
  const results: Array<{ usage: Usage; at: number; peak: boolean }> = [];
  let next = 0;
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < CALLS) {
        const i = next++;
        try {
          results.push(await call(i));
        } catch (e) {
          failures.push(String(e));
        }
      }
    }),
  );
  const after = await balance();

  // Price every response with the price book. A call priced at peak uses peak rates, so the window is recorded.
  const rates = PRICES.deepseek[MODEL];
  let expected = 0;
  let inputMiss = 0, inputHit = 0, output = 0, reasoning = 0;
  for (const { usage, peak } of results) {
    const pick = (r: { peak: number; offPeak: number }) => (peak ? r.peak : r.offPeak);
    expected +=
      (usage.prompt_cache_miss_tokens * pick(rates.inputMiss) +
        usage.prompt_cache_hit_tokens * pick(rates.inputHit) +
        usage.completion_tokens * pick(rates.output)) /
      1_000_000;
    inputMiss += usage.prompt_cache_miss_tokens;
    inputHit += usage.prompt_cache_hit_tokens;
    output += usage.completion_tokens;
    reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
  }
  const observed = before.total - after.total;
  const diff = observed - expected;
  // Each balance reading is rounded to the cent, so the observed change can be off by up to one cent per reading.
  const tolerance = 0.02;

  const report = {
    model: MODEL,
    calls: results.length,
    failures: failures.length,
    failureSample: failures.slice(0, 3),
    window: { startedUtc: new Date(started).toISOString(), endedUtc: new Date(after.at).toISOString(), anyPeak: results.some((r) => r.peak) },
    tokens: { inputMiss, inputHit, output, reasoningIncludedInOutput: reasoning },
    balance: { currency: before.currency, before: before.total, after: after.total },
    usd: { expectedFromUsageAndPriceBook: round(expected), observedFromBalance: round(observed), difference: round(diff), tolerance },
    verdict: results.length === 0 ? "NO DATA" : Math.abs(diff) <= tolerance ? "MATCH" : "MISMATCH",
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "MATCH") process.exitCode = 1;
}

const round = (n: number) => Number(n.toFixed(6));
await main();
