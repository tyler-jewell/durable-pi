import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { askJev, resolveTransport } from "../src/jev.js";
import { requestReviewDecision } from "../src/jobs.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Run fn with exactly these env vars set, restoring the previous values afterwards. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const clearJevEnv = {
  JEV_BASE_URL: undefined,
  JEV_MODEL: undefined,
  JEV_API_KEY: undefined,
  TYPESAFE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  CLOUDFLARE_API_KEY: undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined,
};

function listen(handler: Handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server);
}

test("factory review requires mesh over MCP and rejects an invalid choice", async () => {
  const app = express();
  app.use(express.json());
  const received: unknown[] = [];
  let choice = "approve";
  app.post("/mcp", async (req, res) => {
    if (req.headers.authorization !== "Bearer test-token") return void res.sendStatus(401);
    const mcp = new McpServer({ name: "review-fixture", version: "1" });
    if (req.body.method === "tools/call") received.push(req.body.params.arguments);
    mcp.registerTool("ask_model", {}, () => ({ content: [], structuredContent: { tool: "fixture", answers: {
      verdict: { type: "choice", choice, confidence: 0.9, probabilities: { approve: 0.9, revise: 0.05, reject: 0.05 } },
    } } }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await listen(app);
  const port = (server.address() as { port: number }).port;
  try {
    await withEnv({ DPI_MCP_URL: `http://127.0.0.1:${port}/mcp`, DPI_MCP_TOKEN: "test-token" }, async () => {
      const result = await requestReviewDecision("plan", "facts", "model verdict");
      assert.equal(result.tool, "fixture");
      assert.equal(result.answer.choice, "approve");
      const args = received[0] as Record<string, unknown>;
      assert.equal(args.kind, "decision");
      assert.deepEqual(args.requires, ["mesh", "decision"]);
      assert.deepEqual(args.state, { plan: "plan", facts: "facts", review: "model verdict" });
      choice = "ship-anyway";
      await assert.rejects(requestReviewDecision("plan", "facts", "model verdict"), /invalid verdict/);
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("askJev posts a System One payload to JEV_BASE_URL and unwraps answers", async () => {
  let received: { body: unknown; auth: string | undefined } = { body: undefined, auth: undefined };
  const server = await listen((req, res) => {
    received.auth = req.headers.authorization;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: { a: { type: "noul", noul: 0.7 } } }));
    });
  });
  try {
    const port = (server.address() as { port: number }).port;
    await withEnv(
      { ...clearJevEnv, JEV_BASE_URL: `http://127.0.0.1:${port}`, JEV_MODEL: "test-model", JEV_API_KEY: "sekret" },
      async () => {
        const answers = await askJev({ x: 1 }, { a: { type: "noul", instructions: "rate it" } });
        assert.deepEqual(answers, { a: { type: "noul", noul: 0.7 } });
        assert.deepEqual(received.body, { model: "test-model", state: { x: 1 }, questions: { a: { type: "noul", instructions: "rate it" } } });
        assert.equal(received.auth, "Bearer sekret");
      },
    );
  } finally {
    server.close();
  }
});

test("askJev retries transient 429s then succeeds", async () => {
  let calls = 0;
  const server = await listen((_req, res) => {
    calls++;
    res.statusCode = calls === 1 ? 429 : 200;
    res.setHeader("content-type", "application/json");
    res.end(calls === 1 ? "{}" : JSON.stringify({ answers: { a: { type: "noul", noul: 1 } } }));
  });
  try {
    const port = (server.address() as { port: number }).port;
    await withEnv({ ...clearJevEnv, JEV_BASE_URL: `http://127.0.0.1:${port}` }, async () => {
      const answers = await askJev({}, { a: { type: "noul", instructions: "" } });
      assert.equal(answers.a.type === "noul" && answers.a.noul, 1);
      assert.equal(calls, 2);
    });
  } finally {
    server.close();
  }
});

test("askJev rejects missing and wrong-typed answers", async () => {
  const wrongType = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { a: { type: "choice", choice: "x" } } })); // caller asked for noul
  });
  const missing = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: {} }));
  });
  try {
    const p1 = (wrongType.address() as { port: number }).port;
    const p2 = (missing.address() as { port: number }).port;
    await withEnv({ ...clearJevEnv, JEV_BASE_URL: `http://127.0.0.1:${p1}` }, async () => {
      await assert.rejects(() => askJev({}, { a: { type: "noul", instructions: "" } }), /Jev answer missing: a/);
    });
    await withEnv({ ...clearJevEnv, JEV_BASE_URL: `http://127.0.0.1:${p2}` }, async () => {
      await assert.rejects(() => askJev({}, { a: { type: "noul", instructions: "" } }), /Jev answer missing: a/);
    });
  } finally {
    wrongType.close();
    missing.close();
  }
});

test("resolveTransport picks credentials in order and unwraps Cloudflare envelopes", async () => {
  await withEnv({ ...clearJevEnv, TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" }, async () => {
    const t = resolveTransport();
    assert.equal(t.provider, "system-one");
    assert.equal(t.endpoint, "https://api.typesafe.ai/v1/systemone");
    assert.equal(t.model, "jev-latest");
  });
  await withEnv({ ...clearJevEnv, OPENROUTER_API_KEY: "o" }, async () => {
    assert.equal(resolveTransport().endpoint, "https://openrouter.ai/api/alpha/decisions");
  });
  await withEnv({ ...clearJevEnv, JEV_BASE_URL: "http://127.0.0.1:8080/" }, async () => {
    assert.equal(resolveTransport().endpoint, "http://127.0.0.1:8080");
  });
  await withEnv({ ...clearJevEnv, CLOUDFLARE_API_KEY: "c", CLOUDFLARE_ACCOUNT_ID: "acct" }, async () => {
    const t = resolveTransport();
    assert.equal(t.provider, "cloudflare-workers-ai");
    assert.equal(t.endpoint, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
    assert.equal(t.model, "typesafe/jev");
    // Cloudflare wraps System One answers in its run envelope…
    assert.deepEqual(
      t.answers({ success: true, result: { state: "Completed", result: { answers: { a: { type: "noul", noul: 0.5 } } } } }),
      { a: { type: "noul", noul: 0.5 } },
    );
    // …but Cloudflare-hosted models return the answers directly under result.
    assert.deepEqual(t.answers({ success: true, result: { answers: { a: { type: "noul", noul: 0.5 } } } }), { a: { type: "noul", noul: 0.5 } });
    assert.throws(() => t.answers({ success: false }), /request failed/);
    assert.throws(() => t.answers({ success: true, result: { state: "Failed" } }), /did not complete/);
  });
  await withEnv(clearJevEnv, async () => {
    assert.throws(() => resolveTransport(), /Jev needs TYPESAFE_API_KEY/);
  });
});
