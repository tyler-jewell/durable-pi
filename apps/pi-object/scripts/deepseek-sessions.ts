// Reconcile every DeepSeek consumer of the account against the balance, using only official data:
//   - pi session files (token counts from the API's own usage fields), priced at the tariff in force per message
//   - GET /user/balance (the only ground truth DeepSeek exposes)
//
//   npx tsx scripts/deepseek-sessions.ts --since 2026-11-18T17:40:00Z --baseline 19.90
//
// The key is read from pi's auth store and never printed. Pi's own usage.cost is shown for comparison only:
// it is priced at the catalog (peak) rate, so it overstates off-peak calls.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TARIFF, tariffAt, type Rates, type TariffName } from "../src/tariff.ts";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sinceMs = Date.parse(arg("--since") ?? "1970-01-01T00:00:00Z");
const baseline = arg("--baseline") ? Number(arg("--baseline")) : undefined;
const tolerance = Number(arg("--tolerance") ?? "0.01"); // USD; agreed accounting tolerance
const extra = Number(arg("--extra") ?? "0"); // USD from runs outside pi sessions, e.g. scripts/deepseek-validate.ts
const settle = args.includes("--settle"); // wait for billing to post before reading the balance
const sessionsRoot = join(homedir(), ".pi/agent/sessions");

type Row = { dir: string; model: string; tariff: TariffName; ts: number; miss: number; hit: number; out: number; usd: number; piUsd: number };
const rows: Row[] = [];

function scan(file: string, dir: string) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const m = entry.message;
    if (!m || m.role !== "assistant" || !m.usage) continue;
    const model = String(m.model ?? "");
    if (!model.startsWith("deepseek-") || !(model in TARIFF.models)) continue;
    const ts = Number(m.timestamp ?? Date.parse(entry.timestamp));
    if (ts < sinceMs) continue;
    const tariff = tariffAt(ts);
    const r: Rates = TARIFF.models[model][tariff];
    // pi's usage.input = cache-miss prompt tokens, usage.cacheRead = cache-hit tokens (checked against the API fields).
    const miss = m.usage.input ?? 0, hit = m.usage.cacheRead ?? 0, out = m.usage.output ?? 0;
    const usd = (miss * r.input + hit * r.cacheRead + out * r.output) / 1e6;
    rows.push({ dir: dir.replace(sessionsRoot + "/", ""), model, tariff, ts, miss, hit, out, usd, piUsd: m.usage.cost?.total ?? 0 });
  }
}
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".jsonl")) scan(p, dir);
  }
}
walk(sessionsRoot);

const groups = new Map<string, { n: number; miss: number; hit: number; out: number; usd: number; piUsd: number }>();
for (const r of rows) {
  const k = `${r.dir} | ${r.model} | ${r.tariff}`;
  const g = groups.get(k) ?? { n: 0, miss: 0, hit: 0, out: 0, usd: 0, piUsd: 0 };
  g.n++; g.miss += r.miss; g.hit += r.hit; g.out += r.out; g.usd += r.usd; g.piUsd += r.piUsd;
  groups.set(k, g);
}
console.log(`window since ${new Date(sinceMs).toISOString()}  messages=${rows.length}`);
for (const [k, g] of groups) {
  console.log(`${k}\n    n=${g.n} miss=${g.miss} hit=${g.hit} out=${g.out}  tariff=$${g.usd.toFixed(6)}  pi-catalog=$${g.piUsd.toFixed(6)}`);
}
if (args.includes("--list")) {
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    console.log(`${new Date(r.ts).toISOString()} ${r.tariff.padEnd(8)} ${r.model} miss=${r.miss} hit=${r.hit} out=${r.out} $${r.usd.toFixed(6)}`);
  }
}
const sessionTotal = rows.reduce((s, r) => s + r.usd, 0);
const tariffTotal = sessionTotal + extra;
const piTotal = rows.reduce((s, r) => s + r.piUsd, 0);
console.log(`TOTAL sessions tariff=${sessionTotal.toFixed(6)} + extra=${extra.toFixed(6)}  (pi-catalog=${piTotal.toFixed(6)})`); console.log(`TOTAL tariff=${tariffTotal.toFixed(6)}  pi-catalog=$${piTotal.toFixed(6)}`);

const key = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")).deepseek?.key;
const readBalance = async () => {
  const res = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` } });
  return Number((await res.json() as { balance_infos: Array<{ total_balance: string }> }).balance_infos[0].total_balance);
};
// Settled = two consecutive reads 60 s apart agree. Gives up after 20 min and says so.
let now = await readBalance();
if (settle) {
  const started = Date.now();
  let stableFor = 0;
  while (stableFor < 2 && Date.now() - started < 20 * 60_000) {
    await new Promise((r) => setTimeout(r, 60_000));
    const next = await readBalance();
    stableFor = next === now ? stableFor + 1 : 0;
    now = next;
  }
  console.log(stableFor >= 2 ? `balance settled after ${Math.round((Date.now() - started) / 1000)}s` : "balance NOT settled after 20 min");
}
console.log(`balance now=$${now.toFixed(2)} (${new Date().toISOString()})`);
if (baseline !== undefined) {
  const delta = baseline - now;
  const diff = delta - tariffTotal;
  const verdict = Math.abs(diff) <= tolerance ? "PASS" : "FAIL";
  console.log(`balance delta=$${delta.toFixed(2)}  ledger tariff total=$${tariffTotal.toFixed(6)}  diff=$${diff.toFixed(4)}  tolerance=$${tolerance.toFixed(2)}  ${verdict}`);
  console.log("note: balance is rounded to cents, so each reading can be off by up to $0.005");
  if (verdict === "FAIL") process.exitCode = 1;
}
