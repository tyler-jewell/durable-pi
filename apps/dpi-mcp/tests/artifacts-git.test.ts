import { test } from "node:test";
import assert from "node:assert/strict";
import { pushBaseline, type ArtifactsClient, type GitResult } from "../src/artifacts-git.js";

function client(calls: { url: string; method: string; body?: unknown }[], gitCalls: { args: string[]; header: string }[]): ArtifactsClient {
  return {
    async fetch(url, init) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      const path = String(url);
      if (path.endsWith("/namespaces/dpi") && (init?.method ?? "GET") === "GET") return Response.json({ success: true, result: { namespace: "dpi" } });
      if (path.endsWith("/repos/durable-pi") && (init?.method ?? "GET") === "GET") return Response.json({ success: true, result: { remote: "https://example.artifacts.cloudflare.net/git/dpi/durable-pi.git" } });
      if (path.endsWith("/tokens")) return Response.json({ success: true, result: { plaintext: "art_secret?expires=1" } });
      return Response.json({ success: false }, { status: 500 });
    },
    async git(args, env) {
      gitCalls.push({ args, header: env.GIT_CONFIG_VALUE_0 ?? "" });
      const result: GitResult = { code: 0, out: "", err: "" };
      return result;
    },
    async origin() {
      return "https://example.invalid/public.git";
    },
    async head() {
      return "abc123";
    },
  };
}

test("a push uses a short-lived write token and then updates the public main branch without that token", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const gitCalls: { args: string[]; header: string }[] = [];
  const result = await pushBaseline(client(calls, gitCalls), { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "api" });
  assert.equal(result.mirrored, true);
  assert.equal(result.head, "abc123");
  const minted = calls.find((call) => call.url.endsWith("/tokens"));
  assert.equal((minted?.body as { ttl: number }).ttl, 900);
  assert.equal((minted?.body as { scope: string }).scope, "write");
  assert.match(gitCalls[0].header, /Bearer art_secret/);
  assert.deepEqual(gitCalls[1].args, ["push", "https://example.invalid/public.git", "HEAD:main"]);
  assert.equal(gitCalls[1].header, "");
});
