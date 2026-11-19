// Cost configuration for this project: the inputs a cost object needs that the provider does not report.
// Plain values, not secrets, so they live in code and are reviewed like any other change.
//
// topUpUsd: the lifetime USD you have topped up on the DeepSeek account. Update it after each top-up.
//           Null means "not set yet": the cost object reports `unconfigured` and shows no dollars.
// grantedUsd: the lifetime granted (free) credit the account has received.

import type { DeepseekConfig } from "./objects.js";

export const COST_CONFIG: { deepseek: DeepseekConfig & { label: string } } = {
  // Confirmed against the DeepSeek platform billing page (19 Nov 2026): total cost $82.13, balance $12.86, granted $0.
  // 82.13 + 12.86 = 94.99 to the cent, so the lifetime top-up is $95.00. Live balance read agrees: total $12.46, no
  // mismatch (topUp - toppedUp = 82.54). Update topUpUsd after each top-up.
  deepseek: { label: "DeepSeek", topUpUsd: 95.0, grantedUsd: 0 },
};

/**
 * The budget guard, per Durable Object per billing period. The account-wide limit (cf billing spend-policies)
 * is the backstop; this cap is what stops one agent from using the whole account budget. Set it below the limit.
 */
export const BUDGET = { perDoUsdPerPeriod: 5 } as const;

export const COST_OBJECT_IDS = ["deepseek", "cloudflare-do"] as const;
export type CostObjectId = (typeof COST_OBJECT_IDS)[number];
