import { test } from "node:test";
import assert from "node:assert/strict";
import { localBashGuard } from "../src/addons.js";

test("the local guard blocks a destructive command and allows a read", () => {
  assert.match(localBashGuard("rm -rf doomed") ?? "", /bash-guard blocked/);
  assert.equal(localBashGuard("ls doomed"), undefined);
  assert.match(localBashGuard("git push --force origin main") ?? "", /bash-guard blocked/);
});
