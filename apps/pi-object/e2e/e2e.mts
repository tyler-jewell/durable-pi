// End-to-end run of the same agent scenario (e2e/contract.ts) on two targets, with one set of checks:
//
//   npm run e2e                   local:  pi in an Apple container (e2e/README.md)
//   npm run e2e:remote            remote: the PiAgent Durable Object on Cloudflare (Workers, Cloudflare Computer)
//
// Both push to a fresh Cloudflare Artifacts repo. The host creates the repo, the agent pushes to it, the host verifies
// the remote itself, then deletes the repo and token (and the namespace if this run created it). The session log and a
// result.json are kept under ~/.dpi/e2e/<run id>/. Nothing else persists.
//
// Secrets: the Cloudflare token is read from .env, and the device token from ~/.dpi/pi-object.token. Both stay in this
// process. Git receives the repo token through per-command environment, the container through stdin, the Worker in the
// request body over TLS. None is printed or logged.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BRANCH, DONE_MARKER, E2E_CONTENT, E2E_FILE, COMMIT_MESSAGE } from "./contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const IMAGE = "dpi-artifacts-dev:local";
const WORKER = "https://durable-pi-object.tyler-jewell.workers.dev";
const NAMESPACE = "dpi-e2e";
const BUDGET_MS = 30_000;
const AGENT_TIMEOUT_MS = 120_000;

const targetArg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "local";
if (targetArg !== "local" && targetArg !== "remote") throw new Error("--target must be local or remote");
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

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const env = loadEnv();
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) throw new Error(".env needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
const artifactsBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces`;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(artifactsBase + path, {
    method,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

interface Proc {
  code: number | null;
  out: string;
  err: string;
}

function proc(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {}): Promise<Proc> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
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

/** What one agent run reports, the same shape for both targets. */
interface AgentRun {
  exitOk: boolean;
  exitDetail: string;
  seedSha: string;
  agentHead: string;
  finished: boolean;
  profile: Record<string, string>;
  extra: Record<string, unknown>;
  /** Called after the run: proves the target's state is gone. */
  stateGone?: () => Promise<{ ok: boolean; detail: string }>;
}

const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);

async function runLocal(remote: string, repoToken: string): Promise<AgentRun> {
  const containerName = runId;
  const t = Date.now();
  const run = await proc(
    "container",
    ["run", "--rm", "--init", "--cpus", "2", "--memory", "1G", "--name", containerName, "-i", IMAGE, "/opt/e2e/inside.sh"],
    { stdin: `${remote}\n${repoToken}\n`, timeoutMs: AGENT_TIMEOUT_MS },
  );
  phase.agent_ms = Date.now() - t;
  writeFileSync(join(logDir, "container.log"), run.out + run.err);
  for (const line of (run.out + run.err).split("\n").filter(Boolean)) log(`  | ${line}`);
  const field = (key: string) => run.out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  const profileLine = run.out.match(/^PROFILE (.*)$/m)?.[1] ?? "";
  const profile: Record<string, string> = {
    runtime: "Apple container (lightweight Linux VM, OCI image)",
    image: IMAGE,
    cpus: "2",
    memory: "1G",
    ...Object.fromEntries(profileLine.split(" ").filter((p) => p.includes("=")).map((p) => p.split("=") as [string, string])),
  };
  const imageLs = (await proc("container", ["image", "ls"])).out.split("\n").find((l) => l.includes("dpi-artifacts-dev")) ?? "";
  profile.image_digest = imageLs.trim().split(/\s+/)[2] ?? "";
  profile.container_cli = (await proc("container", ["--version"])).out.trim();
  return {
    exitOk: run.code === 0,
    exitDetail: `exit ${run.code}`,
    seedSha: field("SEED_SHA"),
    agentHead: field("CONTAINER_HEAD"),
    finished: field("AGENT_EXIT") === "0" && (run.out.includes(DONE_MARKER)),
    profile,
    extra: {
      target: "local",
      containerName,
      toolCalls: Number(field("TOOL_CALLS")),
      turns: Number(field("TURNS")),
    },
  };
}

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
      compatibility: "nodejs_compat, codemode backend",
    },
    extra: {
      target: "remote",
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

async function main(): Promise<number> {
  log(`run ${runId} target=${target}`);
  let createdNamespace = false;
  let repoCreated = false;
  let remote = "";
  let repoToken = "";
  let cloneDir: string | undefined;
  let agent: AgentRun | undefined;
  const result: Record<string, unknown> = { runId, target, namespace: NAMESPACE };

  try {
    // 1. Namespace (created only if missing; removed at the end only if this run created it).
    let t = Date.now();
    const ns = await api("GET", `/${NAMESPACE}`);
    if (ns.status === 404) {
      const created = await api("POST", "", { namespace: NAMESPACE });
      createdNamespace = created.status === 200 || created.status === 201;
      check("namespace created", createdNamespace, `HTTP ${created.status}`);
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
    log(`remote ${remote}`);
    phase.repo_create_ms = Date.now() - t;

    // 3. The agent run on the chosen target.
    agent = target === "local" ? await runLocal(remote, repoToken) : await runRemote(remote, repoToken);
    check("agent run exited 0", agent.exitOk, agent.exitDetail);
    check("agent finished", agent.finished, DONE_MARKER);
    check("seed pushed by the agent", isSha(agent.seedSha));
    check("agent commit pushed", isSha(agent.agentHead) && agent.agentHead !== agent.seedSha);
    result.profile = agent.profile;
    result.agent = agent.extra;

    // 4. Host-side verification: the remote itself, read with a token that lives only in this process.
    t = Date.now();
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
    // 5. Teardown: repo, token, namespace, clone, and the target's own state. Then prove the token no longer works.
    const t = Date.now();
    if (agent?.stateGone) {
      const gone = await agent.stateGone();
      check("agent state deleted", gone.ok, gone.detail);
    }
    if (repoCreated) {
      // Repo delete is accepted (202) and takes effect asynchronously, so the token check polls for rejection.
      const del = await api("DELETE", `/${NAMESPACE}/repos/${runId}`);
      check("repo delete accepted", del.status === 202 || del.status === 200, `HTTP ${del.status}`);
      let gone = 0;
      for (let i = 0; i < 40 && gone !== 404; i++) {
        gone = (await api("GET", `/${NAMESPACE}/repos/${runId}`)).status;
        if (gone !== 404) await new Promise((r) => setTimeout(r, 250));
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
          if (!rejected) await new Promise((r) => setTimeout(r, 250));
        }
        const waited = ((Date.now() - revokeStart) / 1000).toFixed(2);
        check("token no longer accepted", rejected, `${lastErr || "accepted"}, after ${waited}s`);
        result.tokenRevokeSeconds = Number(waited);
      }
    }
    if (createdNamespace) {
      const delNs = await api("DELETE", `/${NAMESPACE}`);
      check("namespace removed (created by this run)", delNs.status === 200 || delNs.status === 204, `HTTP ${delNs.status}`);
    }
    if (cloneDir) rmSync(cloneDir, { recursive: true, force: true });
    if (target === "local") {
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
