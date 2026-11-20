// Side-by-side table of the newest local, remote and offline e2e runs (result.json files under ~/.dpi/e2e).
//
//   npm run e2e:compare
//
// Reads results only. Prints a markdown table and writes it to ~/.dpi/e2e/compare.md.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(homedir(), ".dpi", "e2e");
type Target = "local" | "remote" | "offline";

/** The parts of a run's result.json this table reads. */
interface Result {
  runId: string;
  target: Target;
  passed: boolean;
  total_ms?: number;
  tokenRevokeSeconds?: number;
  phase_ms?: Record<string, number | undefined>;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  agent: {
    turns?: number;
    toolCalls?: number;
    cost?: { objects?: Array<{ id: string; listUsd?: number }>; usage?: { rows?: Array<{ sku: string; quantity?: number }> } };
  };
  profile: Record<"runtime" | "cf" | "cpus" | "git" | "image" | "image_digest" | "memory" | "node" | "pi" | "worker" | "wrangler", string>;
}

function newest(target: Target): Result {
  const runs = readdirSync(root)
    .filter((d) => d.startsWith(`e2e-${target}-`))
    .map((d) => join(root, d, "result.json"))
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    })
    .map((p) => JSON.parse(readFileSync(p, "utf8")))
    .filter((r) => r.target === target);
  if (runs.length === 0) throw new Error(`no ${target} run found under ${root}`);
  runs.sort((a, b) => (a.runId < b.runId ? 1 : -1));
  return runs[0];
}

const runs: Record<Target, Result> = { local: newest("local"), remote: newest("remote"), offline: newest("offline") };
const cols: Target[] = ["local", "remote", "offline"];

const secs = (ms?: number) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const passed = (r: Result) => `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`;
const detail = (r: Result, name: string) => r.checks.find((c) => c.name.startsWith(name))?.detail ?? "n/a";
const yesNo = (r: Result, name: string) => {
  const c = r.checks.find((x) => x.name.startsWith(name));
  return c ? (c.ok ? "yes" : "NO") : "n/a";
};
const usd = (n: number | undefined | null) => (n === undefined || n === null ? "n/a" : `$${n.toFixed(7)}`);
const cfObj = (r: Result) => r.agent?.cost?.objects?.find((o) => o.id === "cloudflare-do");
const usageRow = (r: Result, sku: string) => r.agent?.cost?.usage?.rows?.find((x) => x.sku === sku)?.quantity;
const phase = (r: Result, k: string) => r.phase_ms?.[k];
const sumPhase = (r: Result, ks: string[]) => (ks.every((k) => phase(r, k) !== undefined) ? ks.reduce((n, k) => n + (phase(r, k) ?? 0), 0) : undefined);

type Row = [string, (r: Result) => string];
const rows: Row[] = [
  ["Run id", (r) => r.runId],
  ["Verdict", (r) => (r.passed ? "PASS" : "FAIL")],
  ["Checks passed", passed],
  ["Wall time (whole run, host)", (r) => secs(r.total_ms)],
  ["Agent run (container / Worker call)", (r) => secs(phase(r, "agent_ms"))],
  ["Setup (namespace/simulator + repo create)", (r) => secs(sumPhase(r, ["namespace_ms", "repo_create_ms"]) ?? (phase(r, "simulator_start_ms") !== undefined ? (phase(r, "simulator_start_ms") ?? 0) + (phase(r, "repo_create_ms") ?? 0) : undefined))],
  ["Host verification of the remote", (r) => secs(phase(r, "verify_ms"))],
  ["Teardown", (r) => secs(phase(r, "teardown_ms"))],
  ["Token refused after repo delete", (r) => (r.tokenRevokeSeconds !== undefined ? `${r.tokenRevokeSeconds} s` : "immediate (simulator)")],
  ["Runtime", (r) => r.profile.runtime],
  ["Artifacts backend", (r) => (r.target === "offline" ? "local simulator (wrangler dev, loopback, bridged)" : r.target === "remote" ? "Cloudflare Artifacts (deployed, us jurisdiction)" : "Cloudflare Artifacts (deployed, us jurisdiction)")],
  ["Cloudflare calls in the run", (r) => (r.target === "offline" ? "none (Artifacts local, no API)" : "Artifacts API and git over HTTPS")],
  ["Image / worker", (r) => (r.target === "remote" ? r.profile.worker : `${r.profile.image} (digest ${r.profile.image_digest ?? "n/a"})`)],
  ["Node / runtime version", (r) => r.profile.node ?? "workerd (Workers runtime, nodejs_compat)"],
  ["git", (r) => r.profile.git ?? "@cloudflare/computer git client (isomorphic-git over the workspace)"],
  ["wrangler / cf / pi", (r) => (r.target === "remote" ? "wrangler 4.165.0 / pi-ai 1.6.0" : `${r.profile.wrangler} / ${r.profile.cf} / ${r.profile.pi}`)],
  ["CPU / memory", (r) => (r.target === "remote" ? "Workers limits (cpuMs 30000, subrequests 500)" : `${r.profile.cpus} vCPU / ${r.profile.memory}`)],
  ["Model", (r) => (r.target === "remote" ? "scripted (pi-ai faux provider)" : "scripted (pi CLI, faux provider)")],
  ["Agent tools used", (r) => (r.target === "remote" ? "write, git_commit_push" : "write, bash (git add/commit/push)")],
  ["Turns / tool calls (pi session)", (r) => `${r.agent.turns} / ${r.agent.toolCalls}`],
  ["Commit: seed + agent", (r) => (yesNo(r, "history is seed") === "yes" ? "2 commits, same file, same subject" : "NOT VERIFIED")],
  ["Remote HEAD matches agent HEAD", (r) => yesNo(r, "remote main equals")],
  ["File content matches e2e/hello.txt", (r) => yesNo(r, "file content")],
  ["Agent state gone after run", (r) => (r.target === "remote" ? detail(r, "agent state deleted") : "container removed (--rm)")],
  ["Account repo count back to baseline", (r) => (r.target === "offline" ? "n/a (no account)" : detail(r, "account repo count"))],
  ["Simulator state removed", (r) => (r.target === "offline" ? yesNo(r, "simulator stopped") : "n/a")],
  ["Cloudflare cost (list, this run)", (r) => (r.target === "remote" ? usd(cfObj(r)?.listUsd) : "n/a (no Cloudflare run)")],
  ["Durable Object requests (this run)", (r) => (r.target === "remote" ? `${usageRow(r, "durable_objects.requests") ?? "n/a"} recorded; duration posts after the response` : "n/a")],
  ["Log directory", (r) => join(root, r.runId)],
];

const header = ["", "Local (Apple container, Cloudflare Artifacts)", "Remote (Cloudflare Durable Object)", "Offline (Apple container, local Artifacts)"];
const md = [
  `| ${header.join(" | ")} |`,
  `|${header.map(() => "---").join("|")}|`,
  ...rows.map(([k, f]) => `| ${k} | ${cols.map((c) => f(runs[c])).join(" | ")} |`),
].join("\n");

console.log(md);
writeFileSync(join(root, "compare.md"), md + "\n");
console.log(`\nwritten to ${join(root, "compare.md")}`);
