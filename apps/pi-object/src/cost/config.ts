// Cost configuration for this project: the inputs a cost object needs that the provider does not report.
// Plain values, not secrets, so they live in code and are reviewed like any other change.
//
// topUpUsd: the lifetime USD you have topped up on the DeepSeek account. Update it after each top-up.
//           Null means "not set yet": the cost object reports `unconfigured` and shows no dollars.
// grantedUsd: the lifetime granted (free) credit the account has received.

import type { DeepseekConfig } from "./objects.js";

export const COST_CONFIG: { deepseek: DeepseekConfig & { label: string } } = {
  // Derived, not typed in: the DeepSeek export (2026-10-20 to 2026-11-18) records $75.454438, all from the paid wallet,
  // and the live balance is $19.54 with $0.00 granted. 75.454438 + 19.54 = 94.99 to the cent, and $95.00 is also within
  // the balance rounding. Assumes no spend before the export window; confirm against the top-up history.
  deepseek: { label: "DeepSeek", topUpUsd: 95.0, grantedUsd: 0 },
};

/**
 * The budget guard, per Durable Object per billing period. The account-wide limit (cf billing spend-policies)
 * is the backstop; this cap is what stops one agent from using the whole account budget. Set it below the limit.
 */
export const BUDGET = { perDoUsdPerPeriod: 5 } as const;

export const COST_OBJECT_IDS = ["deepseek", "cloudflare-do"] as const;
export type CostObjectId = (typeof COST_OBJECT_IDS)[number];
