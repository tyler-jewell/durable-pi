import { QUANT } from "./naming-fixtures.js";
// Core eval: the zero-code-base agent probes a remote host for decision-model capabilities.
//
// The agent is given only a host address + an ssh target and no facts about the host. It must
//  1. identify the decision models, 2. identify the model server, 3. test the server live,
//  4. determine how it is configured, 5. determine whether any launchd service auto-starts it,
//  6. propose a capability, and then — only if the config is right — the eval approves it and
//  7. validates the capability was added with auto-turn-on set.
//
// Everything the agent derives comes from `probeHost` / `inspectHost`; the ground truth lives
// in the mock host + mock ssh below. The eval is offline and deterministic (<1 s).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableCapability,
  probeHost,
  recommendCapability,
  resolveCapability,
  type CapabilityRegistry,
} from "../src/capabilities.js";
import { inspectHost } from "../src/host-inspect.js";

const GROUND_TRUTH = {
  models: ["Delta-Judge" + QUANT, "Epsilon-Judge" + QUANT],
  serverExe: "llama-server",
  modelDir: "/srv/studio-models/gguf",
  alias: "Delta-Judge" + QUANT,
  autoStartServices: [] as string[], // no launchd service auto-starts the model server
};

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server);
}

test("zero-code-base agent discovers, tests, proposes and (if right) approves a decision capability", async () => {
  // Mock remote host: llama.cpp-like decision server.
  const host = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok" }));
    if (req.url === "/v1/models") {
      return void res.end(
        JSON.stringify({
          data: [
            { id: "Delta-Judge" + QUANT, aliases: [], architecture: { output_modalities: ["decisions"] } },
            { id: "Epsilon-Judge" + QUANT, aliases: [], architecture: { output_modalities: ["decisions"] } },
          ],
        }),
      );
    }
    if (req.url === "/v1/systemone") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => void res.end(JSON.stringify({ model: "m", answers: { probe: { type: "noul", noul: 0.5 } } })));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const address = `http://127.0.0.1:${(host.address() as { port: number }).port}`;

  // Mock ssh: returns the host's model-server config (processes + launchd auto-start) as JSON.
  const sshDir = mkdtempSync(join(tmpdir(), "dpi-ssh-"));
  const sshStub = join(sshDir, "ssh");
  writeFileSync(
    sshStub,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
      processes: [
        `30519 1 /opt/homebrew/bin/llama-server --host 127.0.0.1 --port 8080 --no-webui --ctx-size 4096 --models-dir ${GROUND_TRUTH.modelDir} --models-max 1 --sleep-idle-seconds 600`,
        `70686 30519 /opt/homebrew/Cellar/llama.cpp/1.0.0/bin/llama-server --port 62199 --alias ${GROUND_TRUTH.alias} --model ${GROUND_TRUTH.modelDir}/Delta-Judge-Q4_K_M.gguf --ctx-size 4096`,
      ],
      autoStartServices: [],
    }).replace(/'/g, `'\\''`)}'\n`,
  );
  chmodSync(sshStub, 0o755);
  const prevSsh = process.env.DPI_MCP_SSH;
  process.env.DPI_MCP_SSH = sshStub;

  try {
    // --- The zero-code-base agent (derives every fact from tools, hardcodes nothing) ---
    const discovered = await probeHost("studio", address);
    if (discovered.models.length === 0) throw new Error("agent found no models");
    const inspection = await inspectHost("studio", address, discovered.models.map((m) => ({ id: m.id, kind: m.kind })));
    const decision = discovered.models.find((m) => m.kind === "decision");
    if (!decision) throw new Error("agent found no decision model");

    // 1. It identifies the decision models.
    assert.deepEqual(discovered.models.map((m) => [m.id, m.kind]), GROUND_TRUTH.models.map((id) => [id, "decision"]));

    // 2. It identifies the server and 4. its configuration.
    const commands = inspection.config.processes.map((p) => p.command);
    assert.ok(commands.some((c) => c.includes(GROUND_TRUTH.serverExe)), "agent identifies llama-server");
    assert.ok(commands.some((c) => c.includes(`--models-dir ${GROUND_TRUTH.modelDir}`)), "agent determines the model dir");
    assert.ok(commands.some((c) => c.includes(`--alias ${GROUND_TRUTH.alias}`)), "agent determines the model alias");

    // 5. It determines whether a launchd service auto-starts the server.
    assert.deepEqual(inspection.config.autoStartServices, GROUND_TRUTH.autoStartServices, "agent finds no auto-start launch agent");

    // 3. It tests the server live.
    const live = inspection.test;
    assert.ok(live, "agent tests the server");
    assert.equal(live?.health, "ok");
    assert.equal(live?.kind, "decision");
    assert.ok((live?.ms ?? 0) >= 0);
    assert.match(live?.sample ?? "", /noul/);

    // 6. It proposes the capability.
    const reg: CapabilityRegistry = { hosts: [discovered], capabilities: [] };
    const cap = recommendCapability(reg, {
      host: "studio",
      model: decision.id,
      description: "Local System One decision model for the factory's jev-quality gate",
      purpose: ["jev-quality"],
    });
    assert.equal(cap.state, "recommended");
    assert.equal(cap.kind, "decision");
    assert.equal(cap.model, decision.id);

    // --- Approve only if the agent got the config right (the eval's gate) ---
    const configRight =
      commands.some((c) => c.includes(GROUND_TRUTH.serverExe)) &&
      commands.some((c) => c.includes(`--models-dir ${GROUND_TRUTH.modelDir}`)) &&
      commands.some((c) => c.includes(`--alias ${GROUND_TRUTH.alias}`)) &&
      inspection.config.autoStartServices.length === 0 &&
      live?.health === "ok" &&
      live?.kind === "decision";
    assert.ok(configRight, "the agent got the config right, so we approve");

    // 7. Validate the capability was added with auto-turn-on set.
    enableCapability(reg, cap.id, { autoEnable: true });
    const bound = resolveCapability(reg, "jev-quality");
    assert.equal(bound?.id, cap.id, "the capability is bound to jev-quality");
    assert.equal(bound?.state, "enabled");
    assert.equal(bound?.autoEnable, true, "auto-turn-on is set");
  } finally {
    process.env.DPI_MCP_SSH = prevSsh;
    rmSync(sshDir, { recursive: true, force: true });
    host.close();
  }
});
