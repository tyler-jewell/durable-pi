import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, judgeOffline } from "../src/addons.js";
import type { JevAnswer } from "../src/jev.js";

const answers = (effect: string, destructive: number, confidence = 0.9): Record<string, JevAnswer> => ({
  effect: { type: "choice", choice: effect, confidence, probabilities: { read_only: 0, reversible: 0, irreversible: 0 } },
  destructive_intent: { type: "noul", noul: destructive },
});

test("gate: read-only runs, reversible needs approval, irreversible/destructive blocks", () => {
  assert.equal(gate(answers("read_only", 0.05)).action, "allow");
  assert.equal(gate(answers("reversible", 0.1)).action, "approve");
  assert.equal(gate(answers("irreversible", 0.1)).action, "block");
  assert.equal(gate(answers("read_only", 0.8)).action, "block"); // destructive intent overrides read-only effect
  assert.match(gate(answers("reversible", 0.1)).reason, /needs human approval/);
});

test("gate: low-confidence irreversible is not a hard block", () => {
  // irreversible effect but below the 0.6 confidence threshold, and not destructive → allow.
  assert.equal(gate(answers("irreversible", 0.05, 0.3)).action, "allow");
  // same effect, confident → block.
  assert.equal(gate(answers("irreversible", 0.05, 0.9)).action, "block");
});

test("judgeOffline: destructive blocks, reversible approves, read-only allows", async () => {
  assert.equal((await judgeOffline("rm -rf /tmp/x")).action, "block");
  assert.equal((await judgeOffline("git push origin --force")).action, "block");
  assert.equal((await judgeOffline("npm install lodash")).action, "approve");
  assert.equal((await judgeOffline("git commit -m 'x'")).action, "approve");
  assert.equal((await judgeOffline("ls -la")).action, "allow");
  assert.equal((await judgeOffline("cat README.md")).action, "allow");
});
