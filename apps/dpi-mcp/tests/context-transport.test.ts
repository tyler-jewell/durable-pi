// The budget on the real transport, against a mock server that records what it was sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { ContextBudgetError } from "../src/context.js";
import { probeHost, runLlm } from "../src/models.js";

function server(handler: (req: IncomingMessage, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const seen: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push(body);
      const out = handler(req, body);
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.json));
    });
  });
  return { srv, seen };
}

test("a request is sent with the output cap clamped to the served window", async () => {
  const { srv, seen } = server(() => ({ json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } } }));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const big = "y".repeat(3 * 3400); // about 3400 tokens by the estimate, leaving ~700 of a 4096 window
    const r = await runLlm(base, "m", [{ role: "user", content: big }], { contextWindow: 4096 });
    assert.equal(seen[0].max_tokens, r.maxTokens, "the cap that was sent is the one reported");
    assert.ok((seen[0].max_tokens as number) < 2048, "clamped below the requested 2048");
    assert.equal(r.guarded, true);
  } finally {
    srv.close();
  }
});

test("a prompt that cannot fit is refused before anything is sent", async () => {
  const { srv, seen } = server(() => ({ json: { choices: [] } }));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    await assert.rejects(runLlm(base, "m", [{ role: "user", content: "z".repeat(15000) }], { contextWindow: 4096 }), ContextBudgetError);
    assert.equal(seen.length, 0, "no request reached the server");
  } finally {
    srv.close();
  }
});

test("an unknown served window goes through unguarded, and the result says so", async () => {
  const { srv, seen } = server(() => ({ json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } }));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const r = await runLlm(base, "m", [{ role: "user", content: "hi" }]);
    assert.equal(r.guarded, false);
    assert.equal(seen[0].max_tokens, 4096);
  } finally {
    srv.close();
  }
});

test("discovery records the served window from the status args, and the trained length alongside it", async () => {
  const { srv } = server((req) => {
    if (req.url === "/health") return { json: { status: "ok" } };
    if (req.url === "/v1/models")
      return {
        json: {
          data: [
            { id: "Alpha-Judge", architecture: { output_modalities: ["decisions"] }, context_length: 262144, status: { value: "unloaded", args: ["llama-server", "--ctx-size", "4096"] } },
            { id: "Alpha-Chat", architecture: { output_modalities: ["text"] }, context_length: 131072, status: { value: "unloaded", args: ["llama-server", "--ctx-size", "8192"] } },
          ],
        },
      };
    return { status: 404, json: {} };
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const cap = await probeHost("alpha", base);
    const judge = cap.models.find((m) => m.id === "Alpha-Judge")!;
    assert.equal(judge.servedContext, 4096, "served, not the trained 262144");
    assert.equal(judge.trainedContext, 262144);
    assert.equal(cap.models.find((m) => m.id === "Alpha-Chat")?.servedContext, 8192);
  } finally {
    srv.close();
  }
});

test("a single plain server reports its window from /props", async () => {
  const { srv } = server((req) => {
    if (req.url === "/health") return { json: { status: "ok" } };
    if (req.url === "/v1/models") return { json: { data: [{ id: "Solo", architecture: { output_modalities: ["text"] } }] } };
    if (req.url === "/props") return { json: { default_generation_settings: { n_ctx: 16384 } } };
    return { status: 404, json: {} };
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const cap = await probeHost("solo", base);
    assert.equal(cap.models[0].servedContext, 16384);
  } finally {
    srv.close();
  }
});
