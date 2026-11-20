import { QUANT } from "./naming-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { probeHost, runDecision, runLlm } from "../src/models.js";

/** A llama.cpp-style model server: /health, /v1/models (with output_modalities), chat + systemone. */
async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      res.setHeader("content-type", "application/json");
      handler(req, res, body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("probeHost derives chat LLMs and decision models from /v1/models", async () => {
  const server = await listen((req, res) => {
    if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok" }));
    if (req.url === "/v1/models") {
      return void res.end(
        JSON.stringify({
          data: [
            { id: "Alpha-Chat" + QUANT, aliases: [], architecture: { output_modalities: ["text"] } },
            { id: "Delta-Judge" + QUANT, aliases: [], architecture: { output_modalities: ["decisions"] } },
          ],
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    const port = (server.address() as { port: number }).port;
    const cap = await probeHost("box", `http://127.0.0.1:${port}`);
    assert.equal(cap.health, "online");
    assert.equal(cap.reachable, true);
    assert.deepEqual(cap.models.map((m) => [m.id, m.kind]), [
      ["Alpha-Chat" + QUANT, "llm"],
      ["Delta-Judge" + QUANT, "decision"],
    ]);
  } finally {
    server.close();
  }
});

test("probeHost marks an unreachable host offline with a hint", async () => {
  const cap = await probeHost("gone", "http://127.0.0.1:1", 1000);
  assert.equal(cap.reachable, false);
  assert.equal(cap.health, "offline");
  assert.match(cap.error ?? "", /did not answer/);
});

test("runLlm and runDecision call a host's OpenAI and System One endpoints", async () => {
  const server = await listen((req, res, body) => {
    if (req.url === "/v1/chat/completions") {
      return void res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    }
    if (req.url === "/v1/systemone") {
      const q = (body as { questions?: Record<string, { type: string }> }).questions ?? {};
      const answers = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.type === "noul" ? { type: "noul", noul: 0.5 } : { type: "choice", choice: "approve", confidence: 0.9, probabilities: { approve: 0.9 } }]));
      return void res.end(JSON.stringify({ model: "m", answers }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await runLlm(base, "Alpha-Chat" + QUANT, [{ role: "user", content: "hi" }])).text, "hi");
    const r = await runDecision(base, "Delta-Judge" + QUANT, { x: 1 }, { verdict: { type: "choice", instructions: "ship?", criteria: { approve: "yes" } } });
    assert.equal(r.answers.verdict.type, "choice");
    if (r.answers.verdict.type === "choice") assert.equal(r.answers.verdict.choice, "approve");
  } finally {
    server.close();
  }
});

