import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictOf } from "../src/jobs.js";

test("a reviewer's verdict is read through markdown and a label", () => {
  assert.equal(verdictOf("**Verdict: Approved**\n\nThe implementation is complete."), "approve");
  assert.equal(verdictOf("approve: looks good"), "approve");
  assert.equal(verdictOf("Verdict: revise. Fix the footer."), "revise");
  assert.equal(verdictOf("## Rejected\nBroken build."), "reject");
});

test("a sentence that merely mentions a verdict is not one", () => {
  assert.equal(verdictOf("I would not approve this yet."), undefined);
  assert.equal(verdictOf(""), undefined);
});
