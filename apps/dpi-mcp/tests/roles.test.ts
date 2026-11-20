import { test } from "node:test";
import assert from "node:assert/strict";
import { roleOf } from "../src/roles.js";

const AGENT = "agent-token-0123456789";
const ADMIN = "admin-token-0123456789";

test("a token grants exactly the role it was issued for", () => {
  assert.equal(roleOf(ADMIN, AGENT, ADMIN), "admin");
  assert.equal(roleOf(AGENT, AGENT, ADMIN), "agent");
});

test("an unknown, empty or near-miss token grants nothing", () => {
  assert.equal(roleOf("", AGENT, ADMIN), undefined);
  assert.equal(roleOf("wrong", AGENT, ADMIN), undefined);
  assert.equal(roleOf(ADMIN + "x", AGENT, ADMIN), undefined);
  assert.equal(roleOf(AGENT.slice(1), AGENT, ADMIN), undefined);
});

test("without an admin token, only the agent role exists", () => {
  assert.equal(roleOf(AGENT, AGENT, undefined), "agent");
  assert.equal(roleOf(ADMIN, AGENT, undefined), undefined);
});
