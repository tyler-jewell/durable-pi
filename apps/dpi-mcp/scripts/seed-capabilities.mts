// Seed the capability registry from the current system: probe the host's llama-server over its
// mesh address (mesh.json, Cloudflare Tunnel + Access; LLAMA_BASE_URL overrides) and enable one capability per model —
// local text models for chat, local decision models for Jev/Clef — plus a set of Cloudflare
// Workers AI capabilities (recommended, cloud transport) so run_llm/run_decision can fall
// back to cloud. The registry is the source of truth for what models exist.
import { familyOf, probeHost, saveRegistry, type Capability, type CapabilityRegistry } from "../src/capabilities.js";
import { loadMeshConfig } from "../src/mesh-config.js";

const hostName = process.env.LLAMA_HOST ?? "studio";
const meshHost = loadMeshConfig().hosts.find((h) => h.name === hostName);
const base = (process.env.LLAMA_BASE_URL ?? (meshHost ? `https://${meshHost.hostname}` : "")).replace(/\/+$/, "");
if (!base) throw new Error(`no mesh host "${hostName}" in mesh.json and no LLAMA_BASE_URL`);
const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const cfEndpoint = cfAccount ? `https://api.cloudflare.com/client/v4/accounts/${cfAccount}` : "";

const host = await probeHost(hostName, base);
host.models = host.models.length
  ? host.models
  : [
      { id: "gpt-oss-20b-MXFP4", kind: "llm", aliases: [] },
      { id: "Qwen3-30B-A3B-Q4_K_M", kind: "llm", aliases: [] },
      { id: "Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M", kind: "llm", aliases: [] },
      { id: "Qwen3.8-27B-UD-Q4_K_M", kind: "llm", aliases: [] },
      { id: "gemma-4-26B-A4B-it-UD-Q4_K_M", kind: "llm", aliases: [] },
      { id: "granite-4.0-h-micro-Q4_K_M", kind: "llm", aliases: [] },
      { id: "Clef-Flash-Q4_K_M", kind: "decision", aliases: [] },
      { id: "OpenJev-Q4_K_M", kind: "decision", aliases: [] },
      { id: "clairic-flash-Q4_K_M", kind: "decision", aliases: [] },
    ];

const now = Date.now();
const caps: Capability[] = [];
for (const m of host.models) {
  caps.push({
    id: `${hostName}-${m.kind}-${m.id}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: m.id,
    kind: m.kind,
    host: hostName,
    address: base,
    model: m.id,
    transport: "openai-compat",
    family: familyOf(m.id),
    description: `${m.kind === "decision" ? "Decision (System One)" : "Chat"} model served by ${hostName}'s llama-server`,
    purpose: m.kind === "decision" ? ["jev-quality"] : ["agent"],
    state: "enabled",
    autoEnable: true,
    source: "agent",
    inputs: [],
    options: [],
    createdAt: now,
    updatedAt: now,
  });
}

// Cloud fallback: a few Workers AI models, recommended (not enabled) until an api key is supplied.
const cloudLlm = ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/openai/gpt-oss-20b"];
const cloudDecision = ["@cf/cloudflare/clef-flash"];
for (const [kind, ids] of [["llm", cloudLlm], ["decision", cloudDecision]] as const) {
  for (const id of ids) {
    caps.push({
      id: `cloudflare-${kind}-${id.split("/").pop()}`,
      name: id,
      kind,
      host: "cloudflare",
      address: cfEndpoint,
      model: id,
      transport: "cloudflare-workers-ai",
      family: familyOf(id),
      description: "Cloudflare Workers AI model (cloud fallback)",
      purpose: kind === "decision" ? ["jev-quality"] : ["agent"],
      state: "recommended",
      autoEnable: false,
      source: "agent",
      inputs: [{ name: "api_key", description: "Cloudflare Workers AI API key", required: true, secret: true }],
      options: [],
      createdAt: now,
      updatedAt: now,
    });
  }
}

const reg: CapabilityRegistry = { hosts: [host], capabilities: caps };
saveRegistry(reg);
console.log(`seeded ${host.models.length} local capabilities on ${hostName} + ${cloudLlm.length} cloud LLM + ${cloudDecision.length} cloud decision (recommended)`);
