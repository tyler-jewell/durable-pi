const show = (payload) => {
  const title = payload.title || "Approval waiting";
  const body = payload.body || "A job is waiting for your decision.";
  const url = payload.url || "/#approval";
  const tell = () => self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) client.postMessage({ type: "push", title, body, url });
  });
  return self.registration.showNotification(title, {
    body,
    tag: "approval",
    data: { url },
  }).then(tell, tell);
};

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(show(payload));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "push") event.waitUntil(show(event.data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/#approval", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => "focus" in client);
    if (open) {
      open.postMessage({ type: "open-approval", url });
      return open.focus();
    }
    return self.clients.openWindow(url);
  }));
});
