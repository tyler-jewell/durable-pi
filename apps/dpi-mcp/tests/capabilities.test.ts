import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { findCapability, probeHost, resolveCapability, runDecision, runLlm, slug, type Capability, type CapabilityRegistry } from "../src/capabilities.js";

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
            { id: "Coder-7B", aliases: [], architecture: { output_modalities: ["text"] } },
            { id: "Clef-Flash-Q4_K_M", aliases: [], architecture: { output_modalities: ["decisions"] } },
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
      ["Coder-7B", "llm"],
      ["Clef-Flash-Q4_K_M", "decision"],
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

test("capability lifecycle: recommended is not bound, enabled is", () => {
  const base = {
    id: "studio-decision-clef-flash-q4-k-m",
    name: "Clef-Flash",
    kind: "decision" as const,
    host: "studio",
    address: "http://127.0.0.1:8080",
    model: "Clef-Flash-Q4_K_M",
    transport: "openai-compat" as const,
    description: "local judge",
    purpose: ["jev-quality"],
    state: "recommended" as const,
    autoEnable: false,
    source: "agent" as const,
    inputs: [],
    options: [],
    createdAt: 0,
    updatedAt: 0,
  } satisfies Capability;
  const reg: CapabilityRegistry = { hosts: [], capabilities: [base] };
  assert.equal(resolveCapability(reg, "jev-quality"), undefined); // recommended ≠ enabled
  assert.equal(findCapability(reg, "studio-decision-clef-flash-q4-k-m")?.id, base.id);
  const enabled = { ...base, state: "enabled" as const };
  reg.capabilities = [enabled];
  assert.equal(resolveCapability(reg, "jev-quality")?.model, "Clef-Flash-Q4_K_M");
  assert.equal(slug("Studio decision: Clef-Flash-Q4_K_M!"), "studio-decision-clef-flash-q4-k-m");
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
    assert.equal(await runLlm(base, "Coder-7B", [{ role: "user", content: "hi" }]), "hi");
    const answers = await runDecision(base, "Clef-Flash-Q4_K_M", { x: 1 }, { verdict: { type: "choice", instructions: "ship?", criteria: { approve: "yes" } } });
    assert.equal(answers.verdict.type, "choice");
    if (answers.verdict.type === "choice") assert.equal(answers.verdict.choice, "approve");
  } finally {
    server.close();
  }
});
