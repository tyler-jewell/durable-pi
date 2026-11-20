import { test } from "vitest";
import assert from "node:assert/strict";
import { applySendStatus, rememberSubscription, type PushSubscriptionRecord } from "../src/push.js";

const sub = (endpoint: string): PushSubscriptionRecord => ({ endpoint, keys: { p256dh: "p", auth: "a" } });

test("a subscription is stored once per endpoint", () => {
  const first = rememberSubscription([], sub("https://push.example/1"));
  const again = rememberSubscription(first, { ...sub("https://push.example/1"), keys: { p256dh: "q", auth: "b" } });
  assert.equal(again.length, 1);
  assert.equal(again[0]?.keys.p256dh, "q");
});

test("a dead endpoint is removed and a server error is retried", () => {
  const current = [sub("https://push.example/1"), sub("https://push.example/2")];
  assert.equal(applySendStatus(current, "https://push.example/1", 410).subscriptions.length, 1);
  assert.equal(applySendStatus(current, "https://push.example/1", 404).retry, false);
  assert.equal(applySendStatus(current, "https://push.example/1", 503).retry, true);
  assert.equal(applySendStatus(current, "https://push.example/1", 503).subscriptions.length, 2);
});
