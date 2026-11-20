export function pushAvailable(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export function registerPushWorker(): Promise<ServiceWorkerRegistration> | null {
  if (!pushAvailable()) return null;
  return navigator.serviceWorker.register("/sw.js");
}
