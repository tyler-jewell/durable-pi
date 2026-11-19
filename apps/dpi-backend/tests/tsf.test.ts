import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsfConfig, parseTsfConfig } from "../src/tsf.js";
import { reviewVerdict } from "../src/jobs.js";
import type { JevAnswer } from "../src/jev.js";

const VALID = `
defaults:
  provider: cloudflare-ai-gateway
  model: "@cf/deepseek-ai/deepseek-v4-flash-0731"
  tools: [read, bash, edit, write]
  protected: [".tsf/"]
agents:
  - name: planner
    purpose: Turn a request into a plan.
    tools: [read, bash]
    prompt: { system: prompts/planner/system.md }
  - name: builder
    purpose: Implement the plan.
    writes: ["*"]
  - name: reviewer
    purpose: Review.
    jev: true
`;

test("parseTsfConfig parses a valid roster", () => {
  const c = parseTsfConfig(VALID);
  assert.equal(c.agents.length, 3);
  assert.equal(c.agents[0].name, "planner");
  assert.deepEqual(c.agents[0].tools, ["read", "bash"]);
  assert.equal(c.agents[0].prompt?.system, "prompts/planner/system.md");
  assert.deepEqual(c.agents[1].writes, ["*"]);
  assert.equal(c.agents[2].jev, true);
  assert.deepEqual(c.defaults.protected, [".tsf/"]);
});

test("parseTsfConfig rejects an empty roster", () => {
  assert.throws(() => parseTsfConfig("defaults: {}\nagents: []\n"), /non-empty/);
});

test("parseTsfConfig rejects duplicate agent names", () => {
  const dup = "agents:\n  - {name: planner, purpose: a}\n  - {name: planner, purpose: b}\n";
  assert.throws(() => parseTsfConfig(dup), /duplicate agent name/);
});

test("parseTsfConfig rejects a missing purpose", () => {
  assert.throws(() => parseTsfConfig("agents:\n  - {name: planner}\n"), /purpose is required/);
});

test("loadTsfConfig reads a stamped project and returns undefined when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsf-test-"));
  try {
    assert.equal(loadTsfConfig(dir), undefined);
    mkdirSync(join(dir, ".tsf"), { recursive: true });
    writeFileSync(join(dir, ".tsf", "tsf.config.yaml"), VALID);
    const c = loadTsfConfig(dir);
    assert.equal(c?.agents.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The jev-quality reviewer gate: Jev is the judge when it answered, the model reviewer
// stands in when Jev is unreachable (fail-open).
const choice = (choice: string, confidence = 0.9): Record<string, JevAnswer> => ({
  verdict: { type: "choice", choice, confidence, probabilities: { approve: 0, revise: 0, reject: 0 } },
});

test("reviewVerdict: Jev approve passes, revise/reject fail", () => {
  assert.deepEqual(reviewVerdict(choice("approve"), "approve: looks good"), { ok: true, reason: "jev-quality approve (0.90)" });
  assert.equal(reviewVerdict(choice("revise", 0.7), "revise: fix the footer").ok, false);
  assert.equal(reviewVerdict(choice("reject", 0.8), "approve").ok, false);
  assert.match(reviewVerdict(choice("revise"), "revise: fix the footer").reason, /^jev-quality revise/);
});

test("reviewVerdict: fail open to the model reviewer when Jev is absent", () => {
  assert.deepEqual(reviewVerdict(undefined, "approve"), { ok: true, reason: "Approved (model; Jev unavailable)" });
  assert.equal(reviewVerdict(undefined, "reject: broken").ok, false);
  assert.equal(reviewVerdict(undefined, "").ok, false);
  assert.equal(reviewVerdict({ verdict: { type: "noul", noul: 0.5 } }, "approve").ok, true); // wrong-typed answer → model stands
});
