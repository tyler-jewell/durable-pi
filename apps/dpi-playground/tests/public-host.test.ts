import { test } from "node:test";
import assert from "node:assert/strict";
import { publicHosts } from "../apps/dpi-playground-hub/src/guard.ts";

test("a public host is allowed with and without the https port", () => {
  assert.deepEqual(publicHosts("Admin.Example, other.example:8443"), [
    "admin.example",
    "admin.example:443",
    "other.example:8443",
  ]);
});

test("an empty public host list adds nothing", () => {
  assert.deepEqual(publicHosts(""), []);
  assert.deepEqual(publicHosts(undefined), []);
});
