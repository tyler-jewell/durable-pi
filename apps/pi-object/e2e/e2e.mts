// End-to-end run of one agent scenario (e2e/contract.ts) on three targets, with one set of checks:
//
//   npm run e2e                  local:   pi in an Apple container; Artifacts on Cloudflare
//   npm run e2e:remote           remote:  the PiAgent Durable Object on Cloudflare; Artifacts on Cloudflare
//   npm run e2e:offline          offline: pi in an Apple container; Artifacts is wrangler dev's local simulator
//
// Every target pushes to a fresh Artifacts repo and the host verifies the remote itself. The host creates the repo, the
// agent pushes to it, the host checks it, then tears everything down. Each run keeps a session log and result.json under
// ~/.dpi/e2e/<run id>/. Nothing else persists.
//
// Offline: no call reaches Cloudflare. The simulator is started on loopback, and a TCP bridge on the container's bridge
// address forwards to it, so the container can reach the simulator. The host verifies over loopback.
//
// Secrets: the Cloudflare token is read from .env, and the device token from ~/.dpi/pi-object.token. Both stay in this
// process. Git gets the repo token through per-command environment (GIT_CONFIG_*), the container through stdin, and the
// Worker through the request body over TLS. None is printed or logged.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BRANCH, DONE_MARKER, E2E_CONTENT, E2E_FILE, COMMIT_MESSAGE } from "./contract.ts";
import { api, JURISDICTION, NAMESPACE, repoCount } from "./artifacts-api.mts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SIM_DIR = join(here, "artifacts-sim");
const IMAGE = "dpi-artifacts-dev:local";
const WORKER = "https://durable-pi-object.tyler-jewell.workers.dev";
const BUDGET_MS = 30_000;
const AGENT_TIMEOUT_MS = 120_000;

const targetArg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "local";
if (targetArg !== "local" && targetArg !== "remote" && targetArg !== "offline") {
  throw new Error("--target must be local, remote or offline");
}
const target = targetArg;

const started = Date.now();
const runId = `e2e-${target}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const logDir = join(homedir(), ".dpi", "e2e", runId);
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logFile = join(logDir, "run.log");
const phase: Record<string, number> = {};

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  appendFileSync(logFile, line + "\n");
  console.log(line);
}

interface Proc {
  code: number | null;
  out: string;
  err: string;
}

function proc(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number; cwd?: string } = {}): Promise<Proc> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Git auth for one command: the token goes into the child's environment, never onto argv. */
const gitEnv = (token: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
});

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one agent run reports: the same shape for every target. */
interface AgentRun {
  exitOk: boolean;
  exitDetail: string;
  seedSha: string;
  agentHead: string;
  finished: boolean;
  profile: Record<string, string>;
  extra: Record<string, unknown>;
  /** Called after the run: proves the target's own state is gone. */
  stateGone?: () => Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------- container agent (local and offline)

async function runContainer(agentRemote: string, repoToken: string, label: string): Promise<AgentRun> {
  const containerName = runId;
  const t = Date.now();
  const run = await proc(
    "container",
    ["run", "--rm", "--init", "--cpus", "2", "--memory", "1G", "--name", containerName, "-i", IMAGE, "/opt/e2e/inside.sh"],
    { stdin: `${agentRemote}\n${repoToken}\n`, timeoutMs: AGENT_TIMEOUT_MS },
  );
  phase.agent_ms = Date.now() - t;
  writeFileSync(join(logDir, "container.log"), run.out + run.err);
  for (const line of (run.out + run.err).split("\n").filter(Boolean)) log(`  | ${line}`);
  const field = (key: string) => run.out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  const profileLine = run.out.match(/^PROFILE (.*)$/m)?.[1] ?? "";
  const imageLs = (await proc("container", ["image", "ls"])).out.split("\n").find((l) => l.includes("dpi-artifacts-dev")) ?? "";
  const profile: Record<string, string> = {
    runtime: label,
    image: IMAGE,
    cpus: "2",
    memory: "1G",
    ...Object.fromEntries(profileLine.split(" ").filter((p) => p.includes("=")).map((p) => p.split("=") as [string, string])),
    image_digest: imageLs.trim().split(/\s+/)[2] ?? "",
    container_cli: (await proc("container", ["--version"])).out.trim(),
  };
  return {
    exitOk: run.code === 0,
    exitDetail: `exit ${run.code}`,
    seedSha: field("SEED_SHA"),
    agentHead: field("CONTAINER_HEAD"),
    finished: field("AGENT_EXIT") === "0" && run.out.includes(DONE_MARKER),
    profile,
    extra: {
      target,
      containerName,
      toolCalls: Number(field("TOOL_CALLS")),
      turns: Number(field("TURNS")),
    },
  };
}

// ---------------------------------------------------------------- Durable Object agent (remote)

async function runRemote(remote: string, repoToken: string): Promise<AgentRun> {
  const deviceToken = readFileSync(join(homedir(), ".dpi", "pi-object.token"), "utf8").trim();
  const agentName = runId;
  const t = Date.now();
  const res = await fetch(`${WORKER}/v1/e2e?agent=${encodeURIComponent(agentName)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ remote, token: repoToken, runId }),
  });
  const text = await res.text();
  phase.agent_ms = Date.now() - t;
  writeFileSync(join(logDir, "worker-response.json"), text);
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  log(`  | HTTP ${res.status} from ${WORKER}/v1/e2e (${Math.round(Date.now() - t)} ms)`);
  const answer: string = body.answer ?? "";
  return {
    exitOk: res.status === 200,
    exitDetail: `HTTP ${res.status}`,
    seedSha: body.seedSha ?? "",
    agentHead: body.headSha ?? "",
    finished: answer.includes(DONE_MARKER),
    profile: {
      runtime: "Cloudflare Durable Object (workerd), Cloudflare Computer workspace and git client",
      worker: WORKER,
      model: "scripted (pi-ai faux provider)",
      tools: "write, git_commit_push",
      compatibility: "nodejs_compat, codemode backend, compatibility date 2026-11-18",
    },
    extra: {
      target,
      agentName,
      toolCalls: body.toolCalls,
      turns: body.turns,
      workerMs: body.durationMs,
      loopMs: body.loopMs,
      pushedSha: body.pushedSha,
      cost: body.cost,
    },
    stateGone: async () => {
      // The Durable Object deleted its storage at the end of the run, so its workspace file must be gone.
      const r = await fetch(`${WORKER}/file?path=/workspace/repo/README.md&agent=${encodeURIComponent(agentName)}`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      return { ok: r.status === 404, detail: `workspace read HTTP ${r.status}` };
    },
  };
}

// ---------------------------------------------------------------- offline Artifacts: simulator + bridge

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** The container's bridge address on this Mac: the one the containers reach the host on. */
function bridgeAddress(): string {
  const out = spawnSync("ifconfig", ["bridge100"], { encoding: "utf8" }).stdout ?? "";
  const ip = out.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) throw new Error("no container bridge (bridge100): start the container system first (container system start)");
  return ip;
}

interface Sim {
  port: number;
  stop(): Promise<void>;
}

async function startSimulator(): Promise<Sim> {
  if (!existsSync(join(SIM_DIR, "node_modules"))) {
    log("installing the simulator's dependency cache (first run only)");
    const inst = await proc("npm", ["install", "--no-audit", "--no-fund"], { cwd: SIM_DIR, timeoutMs: 600_000 });
    if (inst.code !== 0) throw new Error(`simulator install failed: ${inst.err.slice(-300)}`);
  }
  const port = await freePort();
  const child = spawn("npx", ["cf", "dev", "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: SIM_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let devLog = "";
  child.stdout.on("data", (d) => (devLog += d));
  child.stderr.on("data", (d) => (devLog += d));
  const stop = async () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false);
      if (!up) break;
      await sleep(200);
    }
    writeFileSync(join(logDir, "simulator.log"), devLog.replace(/[a-f0-9]{32}/g, "<id>"));
    // The simulator keeps its state next to its config (.cloudflare/state and .wrangler). Remove both: nothing persists.
    for (const dir of [".cloudflare", ".wrangler"]) rmSync(join(SIM_DIR, dir), { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) {
      return { port, stop };
    }
    await sleep(500);
  }
  await stop();
  throw new Error("simulator did not start");
}

async function simCreate(port: number, name: string): Promise<{ remote: string; token: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (r.status !== 200) throw new Error(`simulator create HTTP ${r.status}`);
  const body = (await r.json()) as { remote: string; token: string };
  return { remote: body.remote, token: body.token };
}

async function simStatus(port: number, name: string): Promise<number> {
  return fetch(`http://127.0.0.1:${port}/repos/${name}`).then((r) => r.status, () => -1);
}

function startBridge(listenHost: string, targetPort: number): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const server: Server = createServer((client) => {
      const upstream = connect(targetPort, "127.0.0.1");
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    server.on("error", reject);
    server.listen(port, listenHost, () =>
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  log(`run ${runId} target=${target}`);
  let createdNamespace = false;
  let repoCreated = false;
  let remote = "";
  let repoToken = "";
  let agentRemote = "";
  let cloneDir: string | undefined;
  let agent: AgentRun | undefined;
  let reposBefore = -1;
  let sim: Sim | undefined;
  let bridge: { port: number; close(): Promise<void> } | undefined;
  const result: Record<string, unknown> = { runId, target, namespace: target === "offline" ? null : NAMESPACE };

  try {
    if (target === "offline") {
      // 1. Simulator on loopback, and the bridge the container will use.
      let t = Date.now();
      sim = await startSimulator();
      phase.simulator_start_ms = Date.now() - t;
      check("local simulator up", true, `port ${sim.port}`);

      t = Date.now();
      const repoName = runId;
      const created = await simCreate(sim.port, repoName);
      repoCreated = true;
      check("repo created in the local simulator", created.remote.startsWith("http://127.0.0.1:"), created.remote.replace(/\/git\/.*/, "/git/..."));
      remote = created.remote;
      repoToken = created.token;
      phase.repo_create_ms = Date.now() - t;

      const gitPort = Number(remote.match(/^http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);
      const bridgeHost = bridgeAddress();
      bridge = await startBridge(bridgeHost, gitPort);
      agentRemote = remote.replace(`http://127.0.0.1:${gitPort}`, `http://${bridgeHost}:${bridge.port}`);
      log(`agent remote ${agentRemote.replace(/\/git\/.*/, "/git/...")} (bridge to the simulator)`);
    } else {
      // Account repo count before the run, to prove the run leaves none behind.
      reposBefore = await repoCount();
      result.reposBefore = reposBefore;

      // 1. Namespace (created only if missing; removed at the end only if this run created it).
      let t = Date.now();
      const ns = await api("GET", `/${NAMESPACE}`);
      if (ns.status === 404) {
        const created = await api("POST", "", { namespace: NAMESPACE, jurisdiction: JURISDICTION });
        createdNamespace = created.status === 200 || created.status === 201;
        check("namespace created", createdNamespace, `HTTP ${created.status}`);
        check("namespace jurisdiction is " + JURISDICTION, created.json?.result?.jurisdiction === JURISDICTION, JSON.stringify(created.json?.result?.jurisdiction ?? null));
      } else {
        check("namespace present", ns.status === 200, `HTTP ${ns.status}`);
      }
      phase.namespace_ms = Date.now() - t;

      // 2. Repo and its short-lived token.
      t = Date.now();
      const repo = await api("POST", `/${NAMESPACE}/repos`, { name: runId });
      repoCreated = repo.status === 200 || repo.status === 201;
      check("repo created", repoCreated, `HTTP ${repo.status}`);
      if (!repoCreated) throw new Error("repo create failed");
      remote = repo.json.result.remote;
      repoToken = repo.json.result.token;
      agentRemote = remote;
      log(`remote ${remote}`);
      phase.repo_create_ms = Date.now() - t;
    }

    // 3. The agent run on the chosen target.
    agent =
      target === "remote"
        ? await runRemote(agentRemote, repoToken)
        : await runContainer(agentRemote, repoToken, target === "offline" ? "Apple container, Artifacts local simulator (wrangler dev) over a loopback bridge" : "Apple container (lightweight Linux VM, OCI image)");
    check("agent run exited 0", agent.exitOk, agent.exitDetail);
    check("agent finished", agent.finished, DONE_MARKER);
    check("seed pushed by the agent", isSha(agent.seedSha));
    check("agent commit pushed", isSha(agent.agentHead) && agent.agentHead !== agent.seedSha);
    result.profile = agent.profile;
    result.agent = agent.extra;

    // 4. Host-side verification: the remote itself, read with a token that lives only in this process.
    let t = Date.now();
    const lsRemote = await proc("git", ["ls-remote", remote, `refs/heads/${BRANCH}`], { env: gitEnv(repoToken) });
    const remoteHead = lsRemote.out.split("\t")[0] ?? "";
    check("remote main equals the agent's HEAD", isSha(agent.agentHead) && remoteHead === agent.agentHead, `remote ${remoteHead.slice(0, 12)}`);

    cloneDir = mkdtempSync(join(tmpdir(), "dpi-e2e-clone-"));
    const clone = await proc("git", ["clone", "-q", remote, join(cloneDir, "c")], { env: gitEnv(repoToken) });
    check("host clone of the remote succeeds", clone.code === 0, `exit ${clone.code}`);
    if (clone.code === 0) {
      const c = join(cloneDir, "c");
      let fileText = "";
      try {
        fileText = readFileSync(join(c, E2E_FILE), "utf8");
      } catch {
        fileText = "";
      }
      check("file content matches", fileText === E2E_CONTENT, E2E_FILE);
      const subject = (await proc("git", ["-C", c, "log", "-1", "--format=%s"])).out.trim();
      check("commit subject matches", subject === COMMIT_MESSAGE, JSON.stringify(subject));
      const count = (await proc("git", ["-C", c, "rev-list", "--count", "HEAD"])).out.trim();
      check("history is seed + agent commit", count === "2", `${count} commits`);
    }
    phase.verify_ms = Date.now() - t;
  } catch (e) {
    check("run completed", false, (e as Error).message);
  } finally {
    // 5. Teardown: the target's own state, the repo, its token, and the namespace if this run created it.
    const t = Date.now();
    if (agent?.stateGone) {
      const gone = await agent.stateGone();
      check("agent state deleted", gone.ok, gone.detail);
    }
    if (target === "offline") {
      if (repoCreated) {
        const del = await fetch(`http://127.0.0.1:${sim!.port}/repos/${runId}`, { method: "DELETE" });
        check("repo deleted in the local simulator", del.status === 204, `HTTP ${del.status}`);
        let status = 0;
        for (let i = 0; i < 20 && status !== 404; i++) {
          status = await simStatus(sim!.port, runId);
          if (status !== 404) await sleep(200);
        }
        check("repo is gone", status === 404, `HTTP ${status}`);
        if (remote && repoToken) {
          const after = await proc("git", ["ls-remote", remote, `refs/heads/${BRANCH}`], { env: gitEnv(repoToken) });
          check("token no longer accepted", after.code !== 0, after.code === 0 ? "accepted" : `exit ${after.code}`);
        }
      }
      if (bridge) await bridge.close();
      check("bridge closed", true);
      if (sim) await sim.stop();
      check("simulator stopped, state removed", !existsSync(join(SIM_DIR, ".cloudflare")) && !existsSync(join(SIM_DIR, ".wrangler")));
    } else {
      if (repoCreated) {
        // Repo delete is accepted (202) and takes effect asynchronously, so the token check polls for rejection.
        const del = await api("DELETE", `/${NAMESPACE}/repos/${runId}`);
        check("repo delete accepted", del.status === 202 || del.status === 200, `HTTP ${del.status}`);
        let gone = 0;
        for (let i = 0; i < 40 && gone !== 404; i++) {
          gone = (await api("GET", `/${NAMESPACE}/repos/${runId}`)).status;
          if (gone !== 404) await sleep(250);
        }
        check("repo is gone", gone === 404, `HTTP ${gone}`);
        if (remote && repoToken) {
          const revokeStart = Date.now();
          let rejected = false;
          let lastErr = "";
          while (!rejected && Date.now() - revokeStart < 10_000) {
            const after = await proc("git", ["ls-remote", remote, `refs/heads/${BRANCH}`], { env: gitEnv(repoToken) });
            rejected = after.code !== 0;
            lastErr = after.err.trim().split("\n").pop() ?? "";
            if (!rejected) await sleep(250);
          }
          const waited = ((Date.now() - revokeStart) / 1000).toFixed(2);
          check("token no longer accepted", rejected, `${lastErr || "accepted"}, after ${waited}s`);
          result.tokenRevokeSeconds = Number(waited);
        }
      }
      // Repo deletes are asynchronous, so the count is polled back to the baseline and the wait is recorded.
      try {
        const waitStart = Date.now();
        let reposAfter = -1;
        while (Date.now() - waitStart < 15_000) {
          reposAfter = await repoCount();
          if (reposAfter === reposBefore) break;
          await sleep(250);
        }
        const waited = ((Date.now() - waitStart) / 1000).toFixed(2);
        check("account repo count back to baseline", reposAfter === reposBefore, `${reposBefore} before, ${reposAfter} after, after ${waited}s`);
        result.repoCountSettleSeconds = Number(waited);
      } catch (e) {
        check("account repo count back to baseline", false, (e as Error).message);
      }
      if (createdNamespace) {
        const delNs = await api("DELETE", `/${NAMESPACE}`);
        check("namespace removed (created by this run)", delNs.status === 200 || delNs.status === 204, `HTTP ${delNs.status}`);
      }
    }
    if (cloneDir) rmSync(cloneDir, { recursive: true, force: true });
    if (target !== "remote") {
      const leftover = (await proc("container", ["list", "-a"])).out.split("\n").filter((l) => l.includes(runId));
      check("no container left behind", leftover.length === 0);
    }
    phase.teardown_ms = Date.now() - t;
  }

  const total = Date.now() - started;
  const passed = checks.every((c) => c.ok);
  const inBudget = total < BUDGET_MS;
  check(`total under ${BUDGET_MS / 1000}s`, inBudget, `${(total / 1000).toFixed(1)}s`);
  result.checks = checks;
  result.phase_ms = phase;
  result.total_ms = total;
  result.passed = passed && inBudget;
  writeFileSync(join(logDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  log(`${result.passed ? "E2E PASS" : "E2E FAIL"} ${runId} target=${target} in ${(total / 1000).toFixed(1)}s; log ${logDir}`);
  return result.passed ? 0 : 1;
}

main().then((code) => process.exit(code));
