export function pushAvailable(): boolean {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function keyBytes(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Ask for notification permission and store the subscription on the hub. */
export async function enablePush(): Promise<string> {
  if (!pushAvailable()) return "This browser cannot receive push";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications were not allowed";
  const registration = await navigator.serviceWorker.ready;
  const key = await fetch("/api/push/key").then((response) => response.json() as Promise<{ publicKey?: string }>);
  if (!key.publicKey) return "The hub has no push key";
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key.publicKey) as BufferSource,
  });
  const saved = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  return saved.ok ? "Phone notifications are on" : "The hub did not store the subscription";
}
