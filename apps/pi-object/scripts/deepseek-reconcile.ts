// Live reconciliation: does the DeepSeek balance drop match what pi recorded for a batch, priced at DeepSeek's rates?
//
//   npx tsx scripts/deepseek-reconcile.ts run [--calls 120] [--concurrency 8]
//
// Steps: read the balance, run N pi calls into an isolated session directory, wait for the balance to settle, read it
// again, then price every recorded DeepSeek call at the rate for its time of day (scripts/deepseek-rates.json).
// PASS when |balance drop − expected| is within $0.01 (the balance is cent-precision, so two readings each carry ±$0.005).
//
// The key is read from pi's auth file inside this process. It is never printed or put on a command line.
// Other consumers of the same key (other machines, other apps) would appear in the drop and not in the expected cost,
// so run this only while nothing else is using the key.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readDeepseekBalance } from "../src/cost/deepseek.js";
import type { DeepseekBalance } from "../src/cost/objects.js";

export interface Rate { cacheHit: number; cacheMiss: number; output: number }
export interface RateCard {
  source?: string;
  retrieved?: string;
  models: Record<string, { offPeak: Rate; peak: Rate }>;
  peakWindowUtc: { hours: number[][] };
}
export interface Usage { input: number; cacheRead: number; output: number }

/** True when the instant falls in DeepSeek's peak window: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function isPeak(ms: number): boolean {
  const d = new Date(ms);
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const h = d.getUTCHours();
  return weekday && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/** Cost of one call at the rate for its time: cache misses (pi `input`), cache hits (pi `cacheRead`), output. */
export function callCostUsd(model: string, usage: Usage, ms: number, card: RateCard): number {
  const m = card.models[model];
  if (!m) throw new Error(`no rate for model ${model}; add it to scripts/deepseek-rates.json`);
  const r = isPeak(ms) ? m.peak : m.offPeak;
  return (usage.input * r.cacheMiss + usage.cacheRead * r.cacheHit + usage.output * r.output) / 1e6;
}

export interface RecordedCall { model: string; at: number; usage: Usage; piCostUsd: number; source: string }

const jsonlFiles = (p: string): string[] =>
  statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => jsonlFiles(join(p, f))) : p.endsWith(".jsonl") ? [p] : [];

/**
 * Every assistant message pi recorded for provider deepseek under a session directory. `source` names where each call
 * came from: the first folder under the directory (for ~/.pi/agent/sessions, the project), or the directory itself.
 */
export function recordedCalls(dir: string): RecordedCall[] {
  const out: RecordedCall[] = [];
  for (const file of jsonlFiles(dir)) {
    const rel = file.slice(dir.length).split("/").filter(Boolean);
    const source = rel.length > 1 ? rel[0] : "batch";
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (entry.type !== "message" || msg?.role !== "assistant" || msg.provider !== "deepseek") continue;
      out.push({
        model: msg.model,
        at: Date.parse(entry.timestamp),
        usage: { input: msg.usage.input, cacheRead: msg.usage.cacheRead, output: msg.usage.output },
        piCostUsd: msg.usage.cost?.total ?? 0,
        source,
      });
    }
  }
  return out;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const loadCard = (): RateCard => JSON.parse(readFileSync(join(here, "deepseek-rates.json"), "utf8"));

function apiKey(): string {
  const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
  const key = auth.deepseek?.key;
  if (typeof key !== "string" || key.startsWith("!")) throw new Error("no plain DeepSeek key in ~/.pi/agent/auth.json");
  return key;
}

const TOPICS = ["tide pools", "compound interest", "the printing press", "bread fermentation", "night trains", "lichens", "public libraries", "salt marshes"];

// stdin is ignored: pi in -p mode waits for stdin to close, so a pipe left open hangs the call.
function runPi(dir: string, i: number): Promise<void> {
  const prompt = `Write about 900 words on ${TOPICS[i % TOPICS.length]} (batch item ${i}). No preamble, no headings.`;
  const args = ["--session-dir", dir, "--provider", "deepseek", "--model", "deepseek-v4-pro", "-p", prompt];
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`pi call ${i} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

async function pool<T>(items: T[], n: number, work: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i], i);
    }
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n: number) => `$${n.toFixed(6)}`;

async function settle(key: string, before: DeepseekBalance): Promise<DeepseekBalance> {
  let last = await readDeepseekBalance(key);
  for (let t = 0; t < 30; t++) {
    await sleep(20_000);
    const now = await readDeepseekBalance(key);
    if (now.total === last.total && now.total !== before.total) return now;
    last = now;
  }
  throw new Error("balance did not settle within 10 minutes");
}

async function run(calls: number, concurrency: number): Promise<void> {
  const card = loadCard();
  const key = apiKey();
  const dir = mkdtempSync(join(tmpdir(), "deepseek-recon-"));

  const before = await readDeepseekBalance(key);
  console.log(`balance before: total ${before.total.toFixed(2)} (topped up ${before.toppedUp.toFixed(2)}, granted ${before.granted.toFixed(2)})`);
  const started = Date.now();
  // Every call runs even if another fails: a failed call may still be billed, so the result is then inconclusive.
  const failures: string[] = [];
  await pool(Array.from({ length: calls }), concurrency, (_, i) => runPi(dir, i).catch((e) => { failures.push(e.message); }));
  console.log(`ran ${calls} calls in ${Math.round((Date.now() - started) / 1000)}s, ${failures.length} failed`);
  for (const f of failures.slice(0, 3)) console.log(`  ${f}`);

  const after = await settle(key, before);
  const drop = before.total - after.total;
  const recorded = recordedCalls(dir);
  const expected = recorded.reduce((s, c) => s + callCostUsd(c.model, c.usage, c.at, card), 0);
  const piEstimate = recorded.reduce((s, c) => s + c.piCostUsd, 0);
  const tokens = recorded.reduce((a, c) => ({ input: a.input + c.usage.input, hit: a.hit + c.usage.cacheRead, out: a.out + c.usage.output }), { input: 0, hit: 0, out: 0 });
  const offPeak = recorded.filter((c) => !isPeak(c.at)).length;

  console.log(`balance after:  total ${after.total.toFixed(2)} (settled)`);
  console.log(`recorded calls: ${recorded.length} (${offPeak} off-peak, ${recorded.length - offPeak} peak)`);
  console.log(`tokens: cache-miss ${tokens.input}, cache-hit ${tokens.hit}, output ${tokens.out}`);
  console.log(`balance drop:        ${usd(drop)}`);
  console.log(`expected (official): ${usd(expected)}`);
  console.log(`pi catalog estimate: ${usd(piEstimate)} (peak rates; overstates off-peak)`);
  const diff = drop - expected;
  console.log(`difference:          ${usd(diff)}`);
  const pass = failures.length === 0 && Math.abs(diff) <= 0.01;
  if (failures.length) console.log("INCONCLUSIVE: some calls failed, so their billing is unknown");
  console.log(pass ? "PASS: within $0.01" : "FAIL: outside $0.01 or calls failed");
  if (!pass) process.exitCode = 1;
}

/**
 * Attribution for a window that other projects also used: every DeepSeek call recorded on this machine since `since`
 * (all pi sessions, plus an optional batch directory), priced at the time-of-call rate. The balance drop since
 * `before` should equal that total. What is left over came from outside this machine (other devices on the same key).
 */
async function attribute(since: number, before: number, batchDir?: string): Promise<void> {
  const card = loadCard();
  const now = await readDeepseekBalance(apiKey());
  const sessions = recordedCalls(join(homedir(), ".pi", "agent", "sessions"));
  const batch = batchDir ? recordedCalls(batchDir) : [];
  const inWindow = [...sessions, ...batch].filter((c) => c.at >= since && c.at <= now.at);
  const bySource = new Map<string, { calls: number; usd: number }>();
  for (const c of inWindow) {
    const row = bySource.get(c.source) ?? { calls: 0, usd: 0 };
    row.calls += 1;
    row.usd += callCostUsd(c.model, c.usage, c.at, card);
    bySource.set(c.source, row);
  }
  const expected = inWindow.reduce((s, c) => s + callCostUsd(c.model, c.usage, c.at, card), 0);
  const drop = before - now.total;
  console.log(`balance from ${before.toFixed(2)} to ${now.total.toFixed(2)}: drop ${usd(drop)}`);
  for (const [source, row] of [...bySource].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${source.padEnd(40)} ${String(row.calls).padStart(4)} calls  ${usd(row.usd)}`);
  }
  const residual = drop - expected;
  console.log(`expected from this machine: ${usd(expected)} (${inWindow.length} calls)`);
  console.log(`residual (outside this machine): ${usd(residual)}`);
  console.log(Math.abs(residual) <= 0.01 ? "PASS: local calls explain the balance within $0.01" : "NOT EXPLAINED: residual above $0.01");
  if (Math.abs(residual) > 0.01) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number) => (arg(flag) === undefined ? fallback : Number(arg(flag)));
  const [cmd] = process.argv.slice(2);
  const fail = (e: Error) => {
    console.error(e.message);
    process.exit(1);
  };
  if (cmd === "run") run(num("--calls", 120), num("--concurrency", 8)).catch(fail);
  else if (cmd === "attribute" && arg("--since") && arg("--before")) {
    attribute(Date.parse(arg("--since")!), Number(arg("--before")), arg("--batch-dir")).catch(fail);
  } else {
    console.error("usage:");
    console.error("  deepseek-reconcile.ts run [--calls 120] [--concurrency 8]");
    console.error("  deepseek-reconcile.ts attribute --since <ISO time> --before <USD balance> [--batch-dir <dir>]");
    process.exit(2);
  }
}
