import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsfConfig, parseTsfConfig } from "../src/tsf.js";

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
