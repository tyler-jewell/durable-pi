// Push subscriptions for the hub. The private key never enters this file.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function rememberSubscription(current: PushSubscriptionRecord[], next: PushSubscriptionRecord): PushSubscriptionRecord[] {
  return [...current.filter((item) => item.endpoint !== next.endpoint), next];
}

export function dropSubscription(current: PushSubscriptionRecord[], endpoint: string): PushSubscriptionRecord[] {
  return current.filter((item) => item.endpoint !== endpoint);
}

const file = () => process.env.DPI_PUSH_FILE ?? join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "push-subscriptions.json");

export function loadSubscriptions(): PushSubscriptionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as PushSubscriptionRecord[];
    return Array.isArray(parsed) ? parsed.filter((item) => item.endpoint && item.keys?.p256dh && item.keys?.auth) : [];
  } catch {
    return [];
  }
}

export function saveSubscriptions(items: PushSubscriptionRecord[]): void {
  const path = file();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
