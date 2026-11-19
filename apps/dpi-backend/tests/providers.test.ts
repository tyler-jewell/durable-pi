import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProviderId } from "../src/providers.js";

test("parseProviderId maps local and keeps the existing aliases", () => {
  assert.equal(parseProviderId("cloudflare"), "cloudflare-ai-gateway");
  assert.equal(parseProviderId("deepseek"), "deepseek");
  assert.equal(parseProviderId("nope"), "openrouter");
});
