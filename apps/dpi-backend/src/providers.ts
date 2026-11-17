// Device model providers. A device runs exactly one provider (DPI_PROVIDER); the
// backend exposes that provider's curated models and routes every agent to it.
// `faux` is the free deterministic provider for tests and offline demos. Adding a
// provider is a spec here, not a change to the store: the rest of the backend is
// provider-agnostic and only reads ProviderId / NetworkProviderSpec.
import type { Provider } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { curatedModels, defaultModelId } from "./model-catalog.js";

export type ProviderId = "openrouter" | "deepseek" | "cloudflare-ai-gateway" | "faux";

export const PROVIDER_IDS = ["openrouter", "deepseek", "cloudflare-ai-gateway", "faux"] as const;

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
    factory: cloudflareAIGatewayProvider,
    models: [
      // Anthropic models served by the gateway (anthropic-messages).
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", tier: "S+", icon: "anthropic.png" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tier: "S+", icon: "anthropic.png" },
      { id: "claude-opus-5", name: "Claude Opus 5", tier: "S+", icon: "anthropic.png" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1", tier: "S+", icon: "anthropic.png" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", tier: "S", icon: "anthropic.png" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tier: "A", icon: "anthropic.png" },
      // OpenAI models served by the gateway (openai-responses).
      { id: "gpt-6-sol", name: "GPT-6 Sol", tier: "S+", icon: "openai.png" },
      { id: "gpt-6-astra", name: "GPT-6 Astra", tier: "S+", icon: "openai.png" },
      { id: "gpt-5.5", name: "GPT-5.5", tier: "S", icon: "openai.png" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", tier: "A", icon: "openai.png" },
      { id: "gpt-4.1", name: "GPT-4.1", tier: "B", icon: "openai.png" },
      // Cloudflare Workers AI models (openai-completions).
      { id: "workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro (CF)", tier: "A", icon: "deepseek.png" },
      { id: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash (CF)", tier: "A", icon: "deepseek.png" },
      { id: "workers-ai/@cf/qwen/qwen3.8-27b", name: "Qwen3.8 27B (CF)", tier: "A", icon: "qwen.png" },
      { id: "workers-ai/@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code (CF)", tier: "A", icon: "kimi.png" },
      { id: "workers-ai/@cf/zai-org/glm-5.3", name: "GLM 5.3 (CF)", tier: "A", icon: "zai.png" },
      { id: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout (CF)", tier: "B", icon: "meta.png" },
    ],
    defaultModelId: "claude-sonnet-5",
  },
};

export function parseProviderId(value: unknown, fallback: ProviderId = "openrouter"): ProviderId {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "cloudflare") return "cloudflare-ai-gateway";
  return (PROVIDER_IDS as readonly string[]).includes(v) ? (v as ProviderId) : fallback;
}
