import { test } from "node:test";
import assert from "node:assert/strict";
import { dropSubscription, rememberSubscription, type PushSubscriptionRecord } from "../apps/dpi-playground-hub/src/push-store.ts";

const sub = (endpoint: string): PushSubscriptionRecord => ({ endpoint, keys: { p256dh: "p", auth: "a" } });

test("a subscription is stored once per endpoint", () => {
  const first = rememberSubscription([], sub("https://push.example/1"));
  const again = rememberSubscription(first, { ...sub("https://push.example/1"), keys: { p256dh: "q", auth: "b" } });
  assert.equal(again.length, 1);
  assert.equal(again[0]?.keys.p256dh, "q");
});

test("dropping an endpoint leaves the others", () => {
  const current = [sub("https://push.example/1"), sub("https://push.example/2")];
  assert.equal(dropSubscription(current, "https://push.example/1").length, 1);
});
