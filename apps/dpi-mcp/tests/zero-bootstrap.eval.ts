// Zero bootstrap, end to end, offline: real HTTP mock model servers, the real Access check (a token is
// required), the real registry, meter and bootstrap. It is the same code the CLI runs, with a mocked mesh.
//
// The mock host "alpha" answers only with the right Access service token (401 otherwise), serves one decision
// model and one chat model, and reports token usage. The mock host "beta" always answers 401, which is what a
// host with a missing or wrong service token looks like. A cloud twin is seeded only to price the chat run;
// the test asserts it is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dpi-zero-eval-"));
const TOKEN_ID = "eval-alpha.access";
const TOKEN_SECRET = "eval-secret";
// Isolate every store before the modules load (they read these at import time).
process.env.DPI_MCP_CAPABILITIES = join(dir, "capabilities.json");
process.env.DPI_MCP_METER = join(dir, "usage.json");
process.env.DPI_MCP_TEAM_FEED = join(dir, "team-feed.json");
process.env.DPI_MCP_MESH = join(dir, "mesh.json");
process.env.CF_ACCESS_EVAL_ALPHA = `${TOKEN_ID}:${TOKEN_SECRET}`;
writeFileSync(process.env.DPI_MCP_MESH, JSON.stringify({ hosts: [{ name: "alpha", hostname: "127.0.0.1", service_token_env: "CF_ACCESS_EVAL_ALPHA" }] }));

const { bootstrap } = await import("../src/zero.js");
const { probeHost, loadRegistry, saveRegistry } = await import("../src/capabilities.js");
const { loadMeter, cloudCostUsd } = await import("../src/meter.js");
const { loadTeamFeed } = await import("../src/notify.js");

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Alpha: a model server behind Access. */
const alpha = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.headers["cf-access-client-id"] !== TOKEN_ID || req.headers["cf-access-client-secret"] !== TOKEN_SECRET) return json(res, 401, { error: "access denied" });
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    if (req.url === "/v1/models")
      return json(res, 200, { data: [{ id: "Eval-Judge", architecture: { output_modalities: ["decisions"] } }, { id: "gpt-oss-20b-MXFP4", architecture: { output_modalities: ["text"] } }] });
    if (req.url === "/v1/systemone")
      return json(res, 200, { answers: { verdict: { type: "choice", choice: "approve", confidence: 0.9, probabilities: { approve: 0.9 } } }, usage: { input_tokens: 120, output_tokens: 0 } });
    if (req.url === "/v1/chat/completions") return json(res, 200, { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 40, completion_tokens: 2 } });
    json(res, 404, {});
  });
});
// Beta: always refuses. This is the same response a mesh host gives with a missing or wrong token.
const beta = createServer((_req, res) => json(res, 401, { error: "access denied" }));
alpha.listen(0, "127.0.0.1");
beta.listen(0, "127.0.0.1");
await Promise.all([once(alpha, "listening"), once(beta, "listening")]);
const alphaUrl = `http://127.0.0.1:${(alpha.address() as { port: number }).port}`;
const betaUrl = `http://127.0.0.1:${(beta.address() as { port: number }).port}`;

/** Discovery for the mock mesh: the same probe the real one uses, with alpha's token and beta without one. */
async function discoverMock() {
  const a = await probeHost("alpha", alphaUrl, 3000, { "CF-Access-Client-Id": TOKEN_ID, "CF-Access-Client-Secret": TOKEN_SECRET });
  const b = await probeHost("beta", betaUrl, 3000);
  return [
    { host: { name: "alpha", hostname: "127.0.0.1" }, address: a.models.length ? alphaUrl : undefined, models: a.models, error: a.error },
    { host: { name: "beta", hostname: "127.0.0.1" }, address: undefined, models: b.models, error: b.error },
  ];
}

function seedCloudTwin() {
  const reg = loadRegistry();
  reg.capabilities.push({
    id: "cloudflare-llm-gpt-oss-20b", name: "@cf/openai/gpt-oss-20b", kind: "llm", host: "cloudflare", address: "http://127.0.0.1:9", model: "@cf/openai/gpt-oss-20b",
    transport: "cloudflare-workers-ai", family: "gpt-oss-20b", description: "cloud twin (must never be called)", purpose: ["agent"], state: "recommended", autoEnable: false,
    source: "agent", inputs: [], options: [], createdAt: 0, updatedAt: 0,
  });
  saveRegistry(reg);
}

test("zero bootstrap: discovers the mesh, enables and tests every local model, reports realized cost, goes A/B", async () => {
  seedCloudTwin();
  const log: string[] = [];
  let shown: { candidates: number; defaults: boolean[] } | undefined;
  const report = await bootstrap({
    discover: discoverMock,
    choose: async (candidates, defaults) => {
      shown = { candidates: candidates.length, defaults };
      return defaults; // the dialog's submit of the pre-checked set
    },
    log: (l) => log.push(l),
  });

  // The mesh: alpha answered, beta is reported with the reason (not as "no model server").
  assert.equal(report.mesh.find((m) => m.host === "alpha")?.models, 2);
  assert.match(report.mesh.find((m) => m.host === "beta")?.error ?? "", /access denied \(HTTP 401\)/);
  assert.ok(log.some((l) => /beta\s+access denied/.test(l)), "the denied host is shown in the mesh listing");

  // The dialog was shown with every discovered model pre-checked.
  assert.deepEqual(shown, { candidates: 2, defaults: [true, true] });

  // Every enabled model passed a live test, and nothing was called in the cloud.
  assert.equal(report.tests.length, 2);
  assert.ok(report.tests.every((t) => t.ok), JSON.stringify(report.tests));
  const chat = report.tests.find((t) => t.kind === "llm");
  assert.ok(chat?.cloudEquivUsd !== undefined, "the chat run is priced against its cloud twin");
  assert.ok(Math.abs((chat?.cloudEquivUsd ?? 0) - cloudCostUsd("@cf/openai/gpt-oss-20b", 40, 2)) < 1e-12, "priced from the actual tokens");
  assert.equal(report.tests.find((t) => t.kind === "decision")?.cloudEquivUsd, undefined, "no cloud twin, so not compared");
  assert.equal(loadRegistry().capabilities.find((c) => c.id === "cloudflare-llm-gpt-oss-20b")?.state, "recommended", "the cloud twin is never enabled");

  // Realized cost: the priced run's electricity against its cloud equivalent; the decision run is not compared.
  assert.equal(report.realized.pricedRuns, 1);
  assert.ok(report.realized.electricityUsd > 0);
  assert.ok(Math.abs(report.realized.savedUsd - (report.realized.cloudEquivUsd - report.realized.pricedElectricityUsd)) < 1e-12);

  // A/B: every candidate is reachable under its required purpose, and nothing leaks.
  for (const row of report.ab) {
    assert.equal(row.leaked.length, 0);
    assert.ok(row.reachable.length > 0);
  }
  assert.equal(report.allTested, true);
  assert.match(log.at(-1) ?? "", /systems a go|all models tested/);

  // The registry is in A/B mode and the team hears about it.
  assert.equal(loadRegistry().selectionMode, "ab");
  assert.equal(loadTeamFeed().at(-1)?.kind, "capability-ready");
  assert.ok(loadMeter().calls.length >= 2, "every validation run is metered");
});

test("zero bootstrap: a deselected decision model means the jev-quality gate is not ready", async () => {
  const report = await bootstrap({
    discover: discoverMock,
    choose: async (candidates) => candidates.map((c) => c.kind !== "decision"), // turn off every decision model
    log: () => {},
  });
  assert.equal(report.selected.length, 1);
  assert.equal(report.allTested, false, "no jev-quality candidate means not ready");
  assert.equal(report.ab.find((r) => r.required.includes("jev-quality"))?.reachable.length, 0);
});

test.after(async () => {
  alpha.close();
  beta.close();
  rmSync(dir, { recursive: true, force: true });
});
