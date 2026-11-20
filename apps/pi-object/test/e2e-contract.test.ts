// The e2e scenario both runs share (e2e/contract.ts): the turn order and the fixed values.

import { test } from "vitest";
import assert from "node:assert/strict";

import * as E from "../e2e/contract.js";

test("the scripted turns are write, then push, then done, for either push tool", () => {
  assert.equal(E.nextStep(undefined), "write");
  assert.equal(E.nextStep({ role: "user" }), "write");
  assert.equal(E.nextStep({ role: "toolResult", toolName: "write" }), "push");
  assert.equal(E.nextStep({ role: "toolResult", toolName: "bash" }), "done");
  assert.equal(E.nextStep({ role: "toolResult", toolName: "git_commit_push" }), "done");
  assert.equal(E.nextStep({ role: "assistant" }), "write");
});

test("the scenario values are fixed: one file, one commit message, one branch", () => {
  assert.equal(E.E2E_FILE, "e2e/hello.txt");
  assert.equal(E.COMMIT_MESSAGE, "e2e: agent change");
  assert.equal(E.BRANCH, "main");
  assert.match(E.E2E_CONTENT, /\n$/);
});
