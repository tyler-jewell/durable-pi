// Cost configuration for this project: the inputs a cost object needs that the provider does not report.
// Plain values, not secrets, so they live in code and are reviewed like any other change.
//
// topUpUsd: the lifetime USD you have topped up on the DeepSeek account. Update it after each top-up.
//           Null means "not set yet": the cost object reports `unconfigured` and shows no dollars.
// grantedUsd: the lifetime granted (free) credit the account has received.

import type { DeepseekConfig } from "./objects.js";

export const COST_CONFIG: { deepseek: DeepseekConfig & { label: string } } = {
  deepseek: { label: "DeepSeek", topUpUsd: null, grantedUsd: 0 },
};

export const COST_OBJECT_IDS = ["deepseek"] as const;
export type CostObjectId = (typeof COST_OBJECT_IDS)[number];
