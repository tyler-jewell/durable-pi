# Phone notifications

An approval can reach a phone through Web Push. The browser delivers it. This repo does not talk to Apple's push service directly.

The shell serves `manifest.webmanifest` and `sw.js` from the origin root. The service worker shows the notification and opens `/` when it is tapped. Subscriptions are kept by endpoint. A `404` or `410` from the push service drops that subscription. A `5xx` keeps it and is retried.

The key names are `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. Values stay in the environment. Generate a pair with `npx web-push generate-vapid-keys`. The Cloudflare recipe is the Durable Object send path: https://developers.cloudflare.com/agents/agent-class/communication-channels/webhooks/push-notifications/

A phone only receives a push from a public HTTPS origin after the app is added to the Home Screen and notification permission is granted from that installed app.
