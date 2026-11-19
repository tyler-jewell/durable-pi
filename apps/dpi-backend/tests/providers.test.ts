import { test } from "node:test";
import assert from "node:assert/strict";
import { networkProviders, parseProviderId } from "../src/providers.js";

test("parseProviderId maps local and keeps the existing aliases", () => {
  assert.equal(parseProviderId("local"), "local");
  assert.equal(parseProviderId("Local"), "local");
  assert.equal(parseProviderId("cloudflare"), "cloudflare-ai-gateway");
  assert.equal(parseProviderId("nope"), "openrouter");
});

test("the local provider points at LLAMA_BASE_URL and resolves ambient (no-key) auth", async () => {
  const prev = process.env.LLAMA_BASE_URL;
  process.env.LLAMA_BASE_URL = "http://127.0.0.1:9999/v1/";
  try {
    const spec = networkProviders.local;
    assert.equal(spec.id, "local");
    assert.deepEqual(spec.envKeys, []);

    const provider = spec.factory();
    assert.equal(provider.baseUrl, "http://127.0.0.1:9999/v1"); // trailing slash stripped
    assert.deepEqual(
      provider.getModels().map((m) => m.id).sort(),
      ["DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M", "Qwen3-Coder-8B-Instruct-Q4_K_M"].sort(),
    );

    const auth = await provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: undefined,
      signal: new AbortController().signal,
    });
    assert.deepEqual(auth?.auth, {});
    assert.deepEqual(spec.models.map((m) => m.id), ["Qwen3-Coder-8B-Instruct-Q4_K_M", "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M"]);
  } finally {
    process.env.LLAMA_BASE_URL = prev;
  }
});
