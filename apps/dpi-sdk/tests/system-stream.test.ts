import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySystemStream, reduceSystemStream, type SystemStreamFrame } from "../src/system-stream.js";

test("hello sets the source and app id, then logs and events accumulate newest-last", () => {
  let view = emptySystemStream();
  view = reduceSystemStream(view, { type: "hello", source: "cloudflare", appId: "checkout-api", startedAt: 1 });
  assert.equal(view.source, "cloudflare");
  assert.equal(view.appId, "checkout-api");

  view = reduceSystemStream(view, { type: "log", at: 2, level: "info", message: "first" });
  view = reduceSystemStream(view, { type: "log", at: 3, level: "warn", message: "second" });
  view = reduceSystemStream(view, { type: "event", at: 4, kind: "agent.started", payload: { agentId: 1 } });
  view = reduceSystemStream(view, { type: "event", at: 5, kind: "job.phase", payload: { job: "release-check", phase: "approve" } });

  assert.deepEqual(view.logs.map((l) => l.message), ["first", "second"]);
  assert.deepEqual(view.events.map((e) => e.kind), ["agent.started", "job.phase"]);
});

test("logs and events are capped at their limits, dropping the oldest", () => {
  let view = emptySystemStream();
  const frame: SystemStreamFrame = { type: "log", at: 0, level: "info", message: "x" };
  for (let i = 0; i < 1050; i++) view = reduceSystemStream(view, frame);
  assert.equal(view.logs.length, 1000);

  let events = emptySystemStream();
  for (let i = 0; i < 600; i++) events = reduceSystemStream(events, { type: "event", at: 0, kind: "e", payload: {} });
  assert.equal(events.events.length, 500);
});
