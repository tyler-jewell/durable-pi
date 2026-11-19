// Durable Pi service worker. Minimal and network-first: the hub is a live agent console, so
// every navigation tries the network first and only falls back to a cached shell when the
// Studio is unreachable. iOS Safari registers the worker but does not support background
// sync or push — that is fine; the install/offline-shell behavior is what matters here.
const CACHE = "durable-pi-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/app-icon-192.png", "/icons/app-icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Network first, cache fallback for the app shell.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && SHELL.includes(new URL(req.url).pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/"))),
  );
});
