// Host pi extension: price DeepSeek at the tariff in force for each request, using pi's own cost metric.
//
// Pi prices a model with one fixed rate table, so it cannot follow DeepSeek's peak schedule by itself. This
// extension registers the two tariffs as ordinary providers (deepseek-peak, deepseek-offpeak), and a virtual
// model (deepseek-tariff/<model>) whose route() runs before every request and picks the tariff for the current
// time. pi-ai then sets usage.cost on each assistant message, so /session, the footer and RPC totals are right
// without any change to pi itself.
//
// Enable it in ~/.pi/agent/settings.json:  "extensions": ["<repo>/apps/pi-object/pi/extensions/deepseek-tariff.ts"]
// Rates and the schedule come only from pricing/deepseek.json.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEEPSEEK_MODELS, TARIFF, deepseekBase, tariffAt, type TariffName } from "../../src/tariff.ts";

const PROVIDER = "deepseek-tariff";

export default function deepseekTariff(pi: ExtensionAPI) {
  for (const tariff of ["peak", "offPeak"] as const) {
    pi.registerProvider(providerFor(tariff), {
      baseUrl: "https://api.deepseek.com",
      // The key comes from pi's own auth store at request time, so no secret is written to any config file.
      apiKey: "!pi auth print-api-key --provider deepseek",
      api: "openai-completions",
      models: DEEPSEEK_MODELS.map((id) => {
        const base = deepseekBase(id);
        return {
          id,
          name: `${base.name} (${tariff === "peak" ? "peak" : "off-peak"} tariff)`,
          reasoning: base.reasoning,
          input: base.input,
          cost: { ...TARIFF.models[id][tariff] },
          contextWindow: base.contextWindow,
          maxTokens: base.maxTokens,
        };
      }),
    });
  }

  for (const id of DEEPSEEK_MODELS) {
    const base = deepseekBase(id);
    pi.registerVirtualModel({
      provider: PROVIDER,
      id,
      name: `${base.name} (tariff-aware)`,
      thinkingLevels: [...(base.reasoning ? ["off", "high"] : ["off"])] as never,
      contextWindow: base.contextWindow,
      maxTokens: base.maxTokens,
      route(request, ctx) {
        const tariff: TariffName = tariffAt(Date.now());
        const model = ctx.modelRegistry.find(providerFor(tariff), id);
        if (!model) throw new Error(`${providerFor(tariff)}/${id} is not registered`);
        return { model, thinkingLevel: request.thinkingLevel as never };
      },
    });
  }
}

const providerFor = (tariff: TariffName) => (tariff === "peak" ? "deepseek-peak" : "deepseek-offpeak");
