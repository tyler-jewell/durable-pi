// The per-Durable-Object budget guard. Pure: the DO supplies the numbers, this decides.
//
// A call is allowed only if the spend so far plus the largest single call seen so far stays within the cap.
// So the most a DO can exceed its cap by is one call, and that bound is reported, not hidden.
// The guard fails closed: if Cloudflare usage cannot be priced (no rate card), no new work starts.

export interface BudgetInput {
  capUsd: number;
  /** Cloudflare spend this billing period at the rate card (`actualUsd`), or null if it cannot be priced. */
  cloudflareUsd: number | null;
  /** LLM spend this billing period, from pi's usage.cost estimate (catalog rate, so an upper bound). */
  llmUsd: number;
  /** The largest single call seen so far: the most the next call is expected to cost. */
  maxCallUsd: number;
}

export interface BudgetDecision {
  allowed: boolean;
  capUsd: number;
  spentUsd: number | null;
  remainingUsd: number | null;
  reason: string;
}

export function budgetDecision(i: BudgetInput): BudgetDecision {
  if (i.cloudflareUsd === null) {
    return { allowed: false, capUsd: i.capUsd, spentUsd: null, remainingUsd: null, reason: "cannot price Cloudflare usage (no rate card), so no new work starts" };
  }
  const spentUsd = i.cloudflareUsd + i.llmUsd;
  const remainingUsd = i.capUsd - spentUsd;
  const allowed = spentUsd + i.maxCallUsd <= i.capUsd;
  return {
    allowed,
    capUsd: i.capUsd,
    spentUsd,
    remainingUsd,
    reason: allowed
      ? "within budget"
      : `budget exhausted: $${spentUsd.toFixed(4)} spent, the next call may cost up to $${i.maxCallUsd.toFixed(4)}, cap ${i.capUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`,
  };
}

/** Thrown before work starts when the budget does not allow it. The Worker answers 402 with the decision. */
export class BudgetExceeded extends Error {
  constructor(public readonly decision: BudgetDecision) {
    super(decision.reason);
    this.name = "BudgetExceeded";
  }
}
