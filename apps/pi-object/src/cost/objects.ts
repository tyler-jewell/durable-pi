// Cost objects: one per billed service. Each turns what the provider reports (or our own telemetry) into dollars,
// and every one has a free-tier toggle, off by default.
//
//   freeTier OFF  -> `usd` is the list cost: as if the service gave no free allowance or credit.
//   freeTier ON   -> `usd` is the actual cost, labelled "free-tier assumed": what was really paid.
//
// Pi's usage.cost is never used here. It is an estimate from pi's catalog and lives in the telemetry only.

/** The provider reports balances to the cent, so every reading is off by up to half a cent. */
export const BALANCE_PRECISION_USD = 0.005;
/** Two readings each carry that error, so an apparent mismatch below this is rounding, not a bug. */
const MISMATCH_TOLERANCE_USD = 0.01;

export type CostStatus = "ok" | "stale" | "unconfigured" | "unavailable" | "config-mismatch";

export interface CostObjectView {
  id: string;
  label: string;
  freeTier: boolean;
  /** What the app bar shows: `actualUsd` when freeTier is on, `listUsd` when it is off. */
  usd: number | null;
  listUsd: number | null;
  actualUsd: number | null;
  /** USD per hour over the last five minutes of consumption, on the same basis as `usd`. */
  burnUsdPerHour: number | null;
  precisionUsd: number;
  asOf: number | null;
  status: CostStatus;
  basis: string;
  note?: string;
}

export interface DeepseekConfig {
  /** Lifetime USD topped up on this account. Update it after every top-up. Null until it is set. */
  topUpUsd: number | null;
  /** Lifetime USD of granted (free) credit the account has received. */
  grantedUsd: number;
}

export interface DeepseekBalance {
  at: number;
  /** Total available: granted plus topped-up. */
  total: number;
  granted: number;
  toppedUp: number;
}

export interface DeepseekViewInput {
  id: string;
  label: string;
  config: DeepseekConfig;
  /** Latest reading, or null when none has ever succeeded. */
  balance: DeepseekBalance | null;
  /** An earlier reading at least five minutes old, for the burn rate. */
  prior: DeepseekBalance | null;
  freeTier: boolean;
  /** Why the latest reading is not current, if it is not. */
  note?: string;
}

/**
 * DeepSeek spend, derived from the balance and the lifetime top-ups. No token rates are used: every token is
 * already paid for through the balance, so the balance is the only ground truth that DeepSeek exposes.
 *
 *   list cost   = topUp + granted - total       (all usage, including the granted credit)
 *   actual cost = topUp - toppedUp              (money actually spent)
 *
 * Both follow from the reported balance and do not depend on the order in which DeepSeek deducts the two pools.
 */
export function deepseekView(input: DeepseekViewInput): CostObjectView {
  const { id, label, config, balance, prior, freeTier, note } = input;
  const base = {
    id, label, freeTier, usd: null, listUsd: null, actualUsd: null, burnUsdPerHour: null,
    precisionUsd: BALANCE_PRECISION_USD, asOf: balance?.at ?? null,
  };
  const basis = freeTier
    ? "free-tier assumed: the money paid (topped-up balance used), not the granted credit"
    : "list cost: all usage at list price, including the granted credit";

  if (config.topUpUsd === null) {
    return { ...base, status: "unconfigured", basis, note: "set topUpUsd in cost.config.ts (lifetime top-ups on this account)" };
  }
  if (!balance) {
    return { ...base, status: "unavailable", basis, note: note ?? "no balance reading yet" };
  }

  const topUp = config.topUpUsd;
  const listUsd = topUp + config.grantedUsd - balance.total;
  const actualUsd = topUp - balance.toppedUp;
  const grantedUsed = config.grantedUsd - balance.granted;
  const mismatch =
    listUsd < -MISMATCH_TOLERANCE_USD || actualUsd < -MISMATCH_TOLERANCE_USD || grantedUsed < -MISMATCH_TOLERANCE_USD;

  let burnUsdPerHour: number | null = null;
  if (prior && balance.at > prior.at) {
    const hours = (balance.at - prior.at) / 3_600_000;
    const consumed = freeTier ? prior.toppedUp - balance.toppedUp : prior.total - balance.total;
    burnUsdPerHour = consumed / hours;
  }

  return {
    ...base,
    usd: freeTier ? actualUsd : listUsd,
    listUsd,
    actualUsd,
    burnUsdPerHour,
    status: mismatch ? "config-mismatch" : note ? "stale" : "ok",
    basis,
    ...(mismatch ? { note: "the balance does not fit the configured top-ups: update topUpUsd / grantedUsd" } : {}),
    ...(note && !mismatch ? { note } : {}),
  };
}
