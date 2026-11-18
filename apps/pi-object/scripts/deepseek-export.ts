// Reconcile a DeepSeek platform usage export against our own session telemetry.
//
//   npx tsx scripts/deepseek-export.ts <export-folder> --key pi-coding-harness
//
// The export folder holds two CSVs from platform.deepseek.com/usage: `cost-*.csv` (cost per day, model, wallet) and
// `amount-*.csv` (tokens per day, model, API key name, token type, price per token). The export is DeepSeek's own
// record, so it is the reference. Checks:
//   1. the amount rows (price x amount) add up to the cost file, to the cent
//   2. the spend for one key, per day and model
//   3. pi session tokens (this machine) against the export for the same key and CST day
// Nothing from the export is written anywhere; the script only prints totals.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
const keyName = args[args.indexOf("--key") + 1];
if (!folder || !keyName) {
  console.error("usage: deepseek-export.ts <export-folder> --key <api-key-name>");
  process.exit(2);
}

type Row = Record<string, string>;
function readCsv(file: string): Row[] {
  const lines = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}
const find = (prefix: string) => {
  const name = readdirSync(folder!).find((f) => f.startsWith(prefix) && f.endsWith(".csv"));
  if (!name) throw new Error(`no ${prefix}*.csv in ${folder}`);
  return join(folder!, name);
};

const cost = readCsv(find("cost-"));
const amount = readCsv(find("amount-"));
const costTotal = cost.reduce((s, r) => s + Number(r.cost || 0), 0);
// Request counts and per-call fees have no per-token price in the amount column. Only priced rows add to spend.
const usdOf = (r: Row) => (r.price ? Number(r.price) * Number(r.amount || 0) : 0);
const amountTotal = amount.reduce((s, r) => s + usdOf(r), 0);

console.log(`export: ${amount.length} amount rows, ${cost.length} cost rows`);
console.log(`check 1: amount rows sum to $${amountTotal.toFixed(6)}, cost file sums to $${costTotal.toFixed(6)}, diff $${(amountTotal - costTotal).toFixed(6)}`);
console.log(`ok: ${Math.abs(amountTotal - costTotal) < 0.005 ? "yes" : "NO"}`);

const keys = [...new Set(amount.map((r) => r.api_key_name))];
console.log("\nspend by API key name:");
for (const k of keys.sort((a, b) => spendFor(b) - spendFor(a))) console.log(`  ${k.padEnd(32)} $${spendFor(k).toFixed(4)}`);
function spendFor(name: string) {
  return amount.filter((r) => r.api_key_name === name).reduce((s, r) => s + usdOf(r), 0);
}

// Tokens per day and model for the chosen key. Export days are in UTC-6 (the account's time zone).
const day = (iso: string) => iso.slice(0, 10);
const exp = new Map<string, { miss: number; hit: number; out: number; usd: number }>();
for (const r of amount.filter((x) => x.api_key_name === keyName)) {
  const k = `${day(r.start_time_iso)} ${r.model}`;
  const e = exp.get(k) ?? { miss: 0, hit: 0, out: 0, usd: 0 };
  const n = Number(r.amount || 0);
  if (r.type === "input_cache_miss_tokens") e.miss += n;
  if (r.type === "input_cache_hit_tokens") e.hit += n;
  if (r.type === "output_tokens") e.out += n;
  e.usd += usdOf(r);
  exp.set(k, e);
}

// Pi session tokens on this machine: assistant messages with provider deepseek, bucketed by CST day.
const host = new Map<string, { miss: number; hit: number; out: number; msgs: number }>();
const root = join(homedir(), ".pi/agent/sessions");
const walk = (dir: string) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".jsonl")) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line).message; } catch { continue; }
        if (!m || m.role !== "assistant" || !m.usage || m.provider !== "deepseek") continue;
        const cst = new Date(Number(m.timestamp) - 6 * 3600_000).toISOString().slice(0, 10);
        const k = `${cst} ${m.model}`;
        const h = host.get(k) ?? { miss: 0, hit: 0, out: 0, msgs: 0 };
        h.miss += m.usage.input; h.hit += m.usage.cacheRead; h.out += m.usage.output; h.msgs += 1;
        host.set(k, h);
      }
    }
  }
};
walk(root);

console.log(`\nkey "${keyName}" by CST day and model: export (DeepSeek) vs pi sessions on this machine`);
console.log("day        model              exp.miss     exp.hit        exp.out   exp.usd   | host.miss    host.hit   host.out  msgs");
for (const k of [...new Set([...exp.keys(), ...host.keys()])].sort()) {
  const e = exp.get(k) ?? { miss: 0, hit: 0, out: 0, usd: 0 };
  const h = host.get(k) ?? { miss: 0, hit: 0, out: 0, msgs: 0 };
  console.log(
    `${k.slice(0, 10)} ${k.slice(11).padEnd(18)} ${String(e.miss).padStart(10)} ${String(e.hit).padStart(12)} ${String(e.out).padStart(12)}  $${e.usd.toFixed(4).padStart(8)}   | ${String(h.miss).padStart(10)} ${String(h.hit).padStart(12)} ${String(h.out).padStart(10)}  ${h.msgs}`,
  );
}
console.log(
  "\nhost < export means other consumers of the same key (container runs, Durable Object runs, scripts). " +
    "host > export would mean pi counts something the export does not, and is a bug to chase.",
);
