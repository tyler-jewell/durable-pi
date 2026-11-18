// Side-by-side table of the newest local and remote e2e runs (their result.json files under ~/.dpi/e2e).
//
//   npm run e2e:compare
//
// Reads results only. Prints a markdown table and writes it to ~/.dpi/e2e/compare.md.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(homedir(), ".dpi", "e2e");

function newest(target: "local" | "remote"): any {
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
    .map((p) => ({ p, r: JSON.parse(readFileSync(p, "utf8")) }))
    .filter(({ r }) => r.target === target);
  if (runs.length === 0) throw new Error(`no ${target} run found under ${root}`);
  runs.sort((a, b) => (a.r.runId < b.r.runId ? 1 : -1));
  return runs[0].r;
}

const L = newest("local");
const R = newest("remote");

const secs = (ms?: number) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const passed = (r: any) => `${r.checks.filter((c: any) => c.ok).length}/${r.checks.length}`;
const check = (r: any, name: string) => r.checks.find((c: any) => c.name.startsWith(name))?.detail ?? "n/a";
const yesNo = (r: any, name: string) => { const c = r.checks.find((x: any) => x.name.startsWith(name)); return c ? (c.ok ? "yes" : "NO") : "n/a"; };
const usd = (n: number | undefined | null) => (n === undefined || n === null ? "n/a" : `$${n.toFixed(7)}`);
const cfObj = (r: any) => r.agent?.cost?.objects?.find((o: any) => o.id === "cloudflare-do");
const usageRow = (r: any, sku: string) => r.agent?.cost?.usage?.rows?.find((x: any) => x.sku === sku)?.quantity;

const rows: Array<[string, string, string]> = [
  ["Run id", L.runId, R.runId],
  ["Verdict", L.passed ? "PASS" : "FAIL", R.passed ? "PASS" : "FAIL"],
  ["Checks passed", passed(L), passed(R)],
  ["Wall time (whole run, host)", secs(L.total_ms), secs(R.total_ms)],
  ["Agent run (container / Worker call)", secs(L.phase_ms.agent_ms), secs(R.phase_ms.agent_ms)],
  ["Namespace + repo create", secs((L.phase_ms.namespace_ms ?? 0) + (L.phase_ms.repo_create_ms ?? 0)), secs((R.phase_ms.namespace_ms ?? 0) + (R.phase_ms.repo_create_ms ?? 0))],
  ["Host verification of the remote", secs(L.phase_ms.verify_ms), secs(R.phase_ms.verify_ms)],
  ["Teardown (repo, token, namespace)", secs(L.phase_ms.teardown_ms), secs(R.phase_ms.teardown_ms)],
  ["Token refused after repo delete", `${L.tokenRevokeSeconds} s`, `${R.tokenRevokeSeconds} s`],
  ["Runtime", L.profile.runtime, R.profile.runtime],
  ["Isolation unit", "one Linux VM per container", "one Durable Object (isolate per object)"],
  ["Image / worker", `${L.profile.image} (digest ${L.profile.image_digest})`, `${R.profile.worker}`],
  ["Node / runtime version", L.profile.node ?? "n/a", "workerd (Workers runtime, nodejs_compat)"],
  ["git", L.profile.git ?? "n/a", "@cloudflare/computer git client (isomorphic-git over the workspace)"],
  ["wrangler / cf / pi", `${L.profile.wrangler} / ${L.profile.cf} / ${L.profile.pi}`, `wrangler 4.164.0 / pi-ai 1.5.2`],
  ["CPU / memory", `${L.profile.cpus} vCPU / ${L.profile.memory}`, "Workers limits (cpuMs 30000, subrequests 500)"],
  ["Model", "scripted (pi CLI, faux provider)", "scripted (pi-ai faux provider)"],
  ["Agent tools used", "write, bash (git add/commit/push)", "write, git_commit_push"],
  ["Turns / tool calls (pi session)", `${L.agent.turns} / ${L.agent.toolCalls}`, `${R.agent.turns} / ${R.agent.toolCalls}`],
  ["Commit: seed + agent", "2 commits, same file, same subject", "2 commits, same file, same subject"],
  ["Remote HEAD matches agent HEAD", yesNo(L, "remote main equals"), yesNo(R, "remote main equals")],
  ["File content matches e2e/hello.txt", yesNo(L, "file content"), yesNo(R, "file content")],
  ["Agent state gone after run", "container removed (--rm)", check(R, "agent state deleted")],
  ["Cloudflare cost (list, this run)", "n/a (local run)", usd(cfObj(R)?.listUsd)],
  ["Durable Object requests (this run)", "n/a", `${usageRow(R, "durable_objects.requests") ?? "n/a"} recorded; duration posts after the response`],
  ["Log directory", join(root, L.runId), join(root, R.runId)],
];

const header = ["", "Local (Apple container)", "Remote (Cloudflare Durable Object)"];
const md = [
  `| ${header.join(" | ")} |`,
  `|${header.map(() => "---").join("|")}|`,
  ...rows.map(([k, a, b]) => `| ${k} | ${a} | ${b} |`),
].join("\n");

console.log(md);
writeFileSync(join(root, "compare.md"), md + "\n");
console.log(`\nwritten to ${join(root, "compare.md")}`);
