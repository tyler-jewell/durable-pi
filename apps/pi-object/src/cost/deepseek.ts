// Reads the DeepSeek account balance: GET https://api-docs.deepseek.com/api/get-user-balance (official).
// Only USD is accepted. Any other currency would be silently mis-costed, so it fails instead.

import type { DeepseekBalance } from "./objects.js";

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

export async function readDeepseekBalance(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<DeepseekBalance> {
  const res = await fetchFn(DEEPSEEK_BALANCE_URL, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`DeepSeek balance HTTP ${res.status}`);
  const body = (await res.json()) as { balance_infos?: BalanceInfo[] };
  const info = body.balance_infos?.find((i) => i.currency === "USD");
  if (!info) throw new Error("DeepSeek balance has no USD entry");

  const num = (s: string) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`DeepSeek balance field is not a number: ${s}`);
    return n;
  };
  return {
    at: now,
    total: num(info.total_balance),
    granted: num(info.granted_balance),
    toppedUp: num(info.topped_up_balance),
  };
}
