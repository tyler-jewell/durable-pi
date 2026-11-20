// The zero bootstrap: ONE script that brings the local model surface online from scratch.
//
//   discover every mesh host's local LLMs + decision models (Cloudflare Tunnel + Access, no hardcoded hosts)
//   → show a dialog asking which to enable
//   → (--auto selects every local model; --select filters by kind)
//   → recommend + enable each, test every enabled model live
//   → "all models tested, systems a go", and the A/B random selection mode is the default.
//
//   npx tsx apps/dpi-mcp/scripts/zero.mts                 # interactive dialog
//   npx tsx apps/dpi-mcp/scripts/zero.mts --auto          # no prompt: enable every local model
//   npx tsx apps/dpi-mcp/scripts/zero.mts --select decision --select llm
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { enableCapability, loadRegistry, recommendCapability, runDecision, runLlm, saveRegistry } from "../src/capabilities.js";
import { discoverMeshModels } from "../src/mesh.js";
import { notifyReady } from "../src/notify.js";

const args = process.argv.slice(2);
const auto = args.includes("--auto");
const select = args.filter((a, i) => a === "--select" && args[i + 1]).map((_, i) => args[args.indexOf("--select", i) + 1]);

async function ask(label: string, choices: { key: string; line: string }[]): Promise<string[]> {
  return new Promise((resolve) => {
    console.log(label);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.line}`));
    const rl = createInterface({ input, output });
    rl.question("  pick numbers (space-separated) or \"all\": ", (answer) => {
      rl.close();
      if (answer.trim() === "all") return resolve(choices.map((c) => c.key));
      const nums = answer.trim().split(/\s+/).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length);
      resolve(nums.map((n) => choices[n - 1].key));
    });
  });
}

// 1. Discover the mesh.
const discovered = await discoverMeshModels();
console.log("== mesh ==");
for (const d of discovered) {
  const where = d.models.length ? `${d.models.length} model(s) @ ${d.address}` : `no model server${d.error ? ` (${d.error.slice(0, 60)})` : ""}`;
  console.log(`  ${d.host.name.padEnd(20)} ${d.host.hostname} ${where}`);
}

// 2. Candidate list: every local model on every host.
const candidates = discovered.flatMap((d) => d.models.map((m) => ({ host: d.host.name, address: d.address!, model: m })));
if (candidates.length === 0) {
  console.error("zero: no local models found on any mesh host. Start a llama-server/Ollama on a host and re-run.");
  process.exit(1);
}
console.log(`\n== ${candidates.length} local model(s) to choose from ==`);

// 3. Dialog: which to enable.
let chosen = candidates;
if (select.length) {
  chosen = candidates.filter((c) => select.includes(c.model.kind));
  console.log(`  --select ${select.join(",")} → ${chosen.length} model(s)`);
} else if (!auto) {
  const keys = await ask(
    "Which models do you want to enable for the start?",
    candidates.map((c, i) => ({ key: String(i), line: `${c.model.id}  [${c.model.kind}] on ${c.host}` })),
  );
  chosen = keys.map((k) => candidates[Number(k)]);
}
if (!chosen.length) {
  console.error("zero: nothing selected.");
  process.exit(1);
}

// 4. Recommend + enable each, then test it live.
const reg = loadRegistry();
const results: { model: string; kind: string; ok: boolean; ms: number; sample: string }[] = [];
for (const c of chosen) {
  const hostEntry = discovered.find((d) => d.host.name === c.host);
  reg.hosts = [...reg.hosts.filter((h) => h.host !== c.host), { host: c.host, address: c.address, health: "online", reachable: true, models: hostEntry?.models ?? [], discoveredAt: Date.now() }];
  const purpose = c.model.kind === "decision" ? ["jev-quality"] : ["agent"];
  const cap = recommendCapability(reg, { host: c.host, model: c.model.id, description: `Discovered ${c.model.kind} by the zero bootstrap`, purpose });
  enableCapability(reg, cap.id, { autoEnable: true });
  const t0 = Date.now();
  let ok = false;
  let sample = "";
  try {
    if (c.model.kind === "decision") {
      const r = await runDecision(cap.address, cap.model, { plan: "zero" }, { probe: { type: "choice", instructions: "approve or reject", criteria: { approve: "ok", reject: "no" } } });
      ok = r.answers.probe !== undefined;
      sample = JSON.stringify(r.answers.probe);
    } else {
      const r = await runLlm(cap.address, cap.model, [{ role: "user", content: "Reply with exactly: OK" }], { timeoutMs: 30_000 });
      ok = r.text.trim().length > 0;
      sample = r.text.trim().slice(0, 40);
    }
  } catch (e) {
    sample = `error: ${String((e as Error).message).slice(0, 60)}`;
  }
  results.push({ model: cap.id, kind: c.model.kind, ok, ms: Date.now() - t0, sample });
  console.log(`  ${ok ? "✓" : "✗"} ${cap.id.padEnd(44)} ${c.model.kind.padEnd(8)} ${Date.now() - t0} ms  ${sample}`);
}
saveRegistry(reg);

// 5. A/B random selection is the default.
reg.selectionMode = "ab";
saveRegistry(reg);

const failed = results.filter((r) => !r.ok);
console.log(`\nselection mode: ${reg.selectionMode} (A/B random)`);
if (failed.length) {
  console.error(`zero: ${failed.length} model(s) failed the live test; they stay enabled but untested.`);
  process.exit(1);
}
console.log("all models tested, systems a go.");

// 6. Tell the team.
notifyReady({
  at: Date.now(),
  kind: "capability-ready",
  message: `zero bootstrap: ${results.length} local model(s) enabled and tested across the mesh (${reg.selectionMode} mode)`,
  validated: { results, selectionMode: reg.selectionMode },
});
