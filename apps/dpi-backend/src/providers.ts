// Device model providers. A device runs exactly one provider (DPI_PROVIDER); the
// backend exposes that provider's curated models and routes every agent to it.
// `faux` is the free deterministic provider for tests and offline demos. Adding a
// provider is a spec here, not a change to the store: the rest of the backend is
// provider-agnostic and only reads ProviderId / NetworkProviderSpec.
import type { Provider } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { curatedModels, defaultModelId } from "./model-catalog.js";
import { MESH_MODELS, meshProvider } from "./mesh-provider.js";

export type ProviderId = "openrouter" | "deepseek" | "cloudflare-ai-gateway" | "mesh" | "faux";

export const PROVIDER_IDS = ["openrouter", "deepseek", "cloudflare-ai-gateway", "mesh", "faux"] as const;

export interface ModelSpec {
  /** Provider-native model id (an OpenRouter slug for openrouter). */
  id: string;
  name: string;
  tier: string;
  /** `/icons/<icon>` served by the web UI. */
  icon: string;
}

export interface NetworkProviderSpec {
  id: Exclude<ProviderId, "faux">;
  label: string;
  /** Env vars the provider reads for auth; `just net up` copies them from `.env` when listed in `env_keys`. */
  envKeys: string[];
  factory: () => Provider;
  models: readonly ModelSpec[];
  defaultModelId: string;
}

export const networkProviders: Record<Exclude<ProviderId, "faux">, NetworkProviderSpec> = {
  // Every agent turn is an `ask_model` call on the dpi-mcp server, which picks among its enabled chat tools.
  mesh: {
    id: "mesh",
    label: "Mesh (dpi-mcp)",
    envKeys: ["DPI_MCP_URL", "DPI_MCP_TOKEN"],
    factory: meshProvider,
    models: MESH_MODELS.map((m) => ({ id: m.id, name: m.name, tier: "M", icon: "lab.png" })),
    defaultModelId: MESH_MODELS[0].id,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    envKeys: ["OPENROUTER_API_KEY"],
    factory: openrouterProvider,
    models: curatedModels,
    defaultModelId,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    envKeys: ["DEEPSEEK_API_KEY"],
    factory: deepseekProvider,
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "S", icon: "deepseek.png" },
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", tier: "A", icon: "deepseek.png" },
    ],
    defaultModelId: "deepseek-v4-pro",
  },
  "cloudflare-ai-gateway": {
    id: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    envKeys: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
    factory: () => {
      // The modern Cloudflare REST API (api.cloudflare.com) with Workers AI models. AI Gateway
      // features apply automatically; `cf-aig-gateway-id` routes the request to our gateway.
      const base = cloudflareWorkersAIProvider();
      const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID?.trim() || "default";
      const id = "cloudflare-ai-gateway";
      const header = { "cf-aig-gateway-id": gatewayId };
      return {
        ...base,
        id,
        name: "Cloudflare AI Gateway",
        headers: { ...base.headers, ...header },
        getModels: () => base.getModels().map((m) => ({ ...m, provider: id, headers: { ...m.headers, ...header } })),
      };
    },
    // Only models whose Workers AI endpoint accepts pi's chat+tools message format. Several text-generation models
    // (llama-3.3-70b-instruct-fp8-fast, gpt-oss, mistral-small, granite, qwen3-30b-a3b-fp8) reject a second turn that
    // replays tool results with a 400 schema error ("content array not in string"), so an agent dies on its first tool
    // use. The list keeps the ones that answer a conversation with tool history; verified 19 Nov 2026.
    models: [
      { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", tier: "S", icon: "deepseek.png" },
      { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", tier: "S", icon: "deepseek.png" },
      { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", tier: "S", icon: "meta.png" },
      { id: "@cf/qwen/qwen3.8-27b", name: "Qwen3.8 27B", tier: "A", icon: "qwen.png" },
      { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6", tier: "A", icon: "kimi.png" },
      { id: "@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code", tier: "A", icon: "kimi.png" },
      { id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", tier: "A", icon: "zai.png" },
      { id: "@cf/zai-org/glm-5.2", name: "GLM 5.2", tier: "A", icon: "zai.png" },
      { id: "@cf/nvidia/nemotron-3-120b-a12b", name: "Nemotron 3 120B", tier: "A", icon: "lab.png" },
      { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", tier: "B", icon: "gemini.png" },
      { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash", tier: "B", icon: "zai.png" },
      { id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash", tier: "B", icon: "zai.png" },
    ],
    defaultModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  },
};

export function parseProviderId(value: unknown, fallback: ProviderId = "openrouter"): ProviderId {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "cloudflare") return "cloudflare-ai-gateway";
  return (PROVIDER_IDS as readonly string[]).includes(v) ? (v as ProviderId) : fallback;
}
