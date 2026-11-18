// What the app bar needs from a cost object. Structural, so any project's /v1/cost report fits without importing
// that project's types. Dollars come only from the cost report; the bar never computes cost itself.
export interface CostReadout {
  id: string;
  label: string;
  /** Shown value: list cost with the free tier off, actual cost with it on. Null when there is no dollar figure. */
  usd: number | null;
  freeTier: boolean;
  status: "ok" | "stale" | "unconfigured" | "unavailable" | "config-mismatch" | string;
  basis: string;
  note?: string;
}
