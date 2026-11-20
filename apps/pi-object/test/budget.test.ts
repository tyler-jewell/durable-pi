// The per-DO budget guard: pure decisions, so every rule is checked without a runtime.

import { test } from "vitest";
import assert from "node:assert/strict";

import { budgetDecision, BudgetExceeded } from "../src/cost/budget.js";

test("a call that fits within the cap is allowed", () => {
  const d = budgetDecision({ capUsd: 5, cloudflareUsd: 1, llmUsd: 2, maxCallUsd: 0.5 });
  assert.equal(d.allowed, true);
  assert.equal(d.spentUsd, 3);
  assert.equal(d.remainingUsd, 2);
});

test("a call that would cross the cap is refused before it starts", () => {
  // Spent 4.8, and the largest call so far is 0.3: 4.8 + 0.3 > 5, so no new call.
  const d = budgetDecision({ capUsd: 5, cloudflareUsd: 2, llmUsd: 2.8, maxCallUsd: 0.3 });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /budget exhausted/);
});

test("exactly reaching the cap is allowed; going one cent past is not", () => {
  assert.equal(budgetDecision({ capUsd: 5, cloudflareUsd: 4, llmUsd: 0.5, maxCallUsd: 0.5 }).allowed, true);
  assert.equal(budgetDecision({ capUsd: 5, cloudflareUsd: 4, llmUsd: 0.5, maxCallUsd: 0.51 }).allowed, false);
});

test("if Cloudflare usage cannot be priced, nothing starts: the guard fails closed", () => {
  const d = budgetDecision({ capUsd: 5, cloudflareUsd: null, llmUsd: 0, maxCallUsd: 0 });
  assert.equal(d.allowed, false);
  assert.equal(d.spentUsd, null);
  assert.match(d.reason, /no rate card/);
});

test("the first call of a period has no measured size yet, so it is allowed up to the cap", () => {
  const d = budgetDecision({ capUsd: 5, cloudflareUsd: 0, llmUsd: 0, maxCallUsd: 0 });
  assert.equal(d.allowed, true);
});

test("overshoot is bounded by one call: the spend can pass the cap only by the largest call", () => {
  // Simulate calls of 0.4 until the guard stops them. The last allowed call ends at most one call above the cap.
  let spent = 0;
  const maxCall = 0.4;
  let calls = 0;
  while (budgetDecision({ capUsd: 5, cloudflareUsd: 0, llmUsd: spent, maxCallUsd: maxCall }).allowed) {
    spent += maxCall;
    calls += 1;
    assert.ok(calls < 100, "guard must stop");
  }
  assert.ok(spent <= 5 + maxCall, `spent ${spent} exceeded cap + one call`);
  assert.ok(spent + maxCall > 5, "and it stopped only when the next call would have crossed");
});

test("BudgetExceeded carries the decision", () => {
  const d = budgetDecision({ capUsd: 1, cloudflareUsd: 1, llmUsd: 0, maxCallUsd: 0.1 });
  const e = new BudgetExceeded(d);
  assert.equal(e.name, "BudgetExceeded");
  assert.equal(e.decision.capUsd, 1);
});
