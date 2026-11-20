export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function rememberSubscription(current: PushSubscriptionRecord[], next: PushSubscriptionRecord): PushSubscriptionRecord[] {
  return [...current.filter((item) => item.endpoint !== next.endpoint), next];
}

export function applySendStatus(current: PushSubscriptionRecord[], endpoint: string, status: number): { subscriptions: PushSubscriptionRecord[]; retry: boolean } {
  if (status === 404 || status === 410) return { subscriptions: current.filter((item) => item.endpoint !== endpoint), retry: false };
  if (status >= 500) return { subscriptions: current, retry: true };
  return { subscriptions: current, retry: false };
}
