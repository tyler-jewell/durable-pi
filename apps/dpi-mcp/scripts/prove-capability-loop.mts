// Prove the capability lifecycle end-to-end, live, with no hardcoded facts about the host:
//
//   discover_host → inspect/validate → recommend → gate → enable (deploy) → end-to-end call → notify_ready
//
// The script is the "agent": every fact comes from probeHost/inspectHost, the gate checks the
// evidence, and the readiness lands in the shared team feed.
//
//   LLAMA_BASE_URL=http://127.0.0.1:18080 DPI_MCP_SSH_HOST=studio npx tsx apps/dpi-mcp/scripts/prove-capability-loop.mts
import { enableCapability, loadRegistry, probeHost, recommendCapability, resolveCapability, runDecision, runLlm, saveRegistry } from "../src/capabilities.js";
import { inspectHost } from "../src/host-inspect.js";
import { notifyReady } from "../src/notify.js";

const host = process.env.DPI_MCP_SSH_HOST ?? "studio";
const address = process.env.LLAMA_BASE_URL ?? "http://studio.tail9d6cad.ts.net:8080";

// 1. discover
const discovered = await probeHost(host, address);
if (discovered.models.length === 0) throw new Error("no models discovered");
console.log(`1. discover: ${host} exposes ${discovered.models.length} models`);

// 2. inspect + live test
const inspection = await inspectHost(host, address, discovered.models.map((m) => ({ id: m.id, kind: m.kind })));
console.log(`2. inspect: ${inspection.config.processes.length} llama-server process(es), ${inspection.config.autoStartServices.length} launchd auto-start(s), live test ${inspection.test?.health} (${inspection.test?.ms} ms)`);

// 3. recommend a capability (prefer a decision model for jev-quality, else an LLM)
const decision = discovered.models.find((m) => m.kind === "decision");
const llm = discovered.models.find((m) => m.kind === "llm");
const model = decision ?? llm;
if (!model) throw new Error("no model to recommend");
const reg = loadRegistry();
reg.hosts = [...reg.hosts.filter((h) => h.host !== host), { ...discovered, ssh: host }];
const purpose = model.kind === "decision" ? ["jev-quality"] : ["agent"];
const cap = recommendCapability(reg, { host, model: model.id, description: `Discovered ${model.kind}, validated live on ${host}`, purpose });
console.log(`3. recommend: ${cap.id} (${cap.kind}, state=${cap.state})`);

// 4. gate: the evidence must be right before we deploy
const commands = inspection.config.processes.map((p) => p.command);
const configRight = commands.some((c) => c.includes("llama-server")) && inspection.test?.health === "ok";
if (!configRight) throw new Error("validation gate failed — not enabling");
console.log(`4. gate: passed (llama-server present + live test ${inspection.test?.health})`);

// 5. deploy: enable now with auto-turn-on
enableCapability(reg, cap.id, { autoEnable: true });
saveRegistry(reg);
console.log(`5. deploy: ${cap.id} enabled (autoEnable=true)`);

// 6. end-to-end call through the registry (same path the tools use)
const bound = resolveCapability(reg, purpose[0])!;
if (!bound) throw new Error(`capability for ${purpose[0]} did not resolve after enable`);
const t0 = Date.now();
const sample =
  bound.kind === "decision"
    ? JSON.stringify((await runDecision(bound.address, bound.model, { plan: "todo app" }, { verdict: { type: "choice", instructions: "ship?", criteria: { approve: "yes", revise: "fix", reject: "no" } } })).answers)
    : (await runLlm(bound.address, bound.model, [{ role: "user", content: "Reply with exactly: OK" }])).text;
const ms = Date.now() - t0;
console.log(`6. end-to-end: ${bound.model} → ${sample.slice(0, 80)} (${ms} ms)`);

// 7. notify the team
const feed = notifyReady({
  at: Date.now(),
  kind: "capability-ready",
  capability: cap.id,
  host,
  model: bound.model,
  purpose,
  validated: { serverExe: "llama-server", autoStartServices: inspection.config.autoStartServices.length, liveTest: inspection.test?.health, endToEndMs: ms },
  message: `${cap.id} validated and deployed on ${host} (${bound.kind}, ${ms} ms end-to-end)`,
});
console.log(`7. notify: team feed now has ${feed.length} entr${feed.length === 1 ? "y" : "ies"} — "${feed[feed.length - 1].message}"`);
console.log("\nLOOP COMPLETE: discover → inspect → recommend → gate → deploy → end-to-end → notify");
