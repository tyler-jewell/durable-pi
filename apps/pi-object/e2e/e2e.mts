// End-to-end run of the default pi agent in an Apple container, pushing to a Cloudflare Artifacts repo.
//
//   npm run e2e            (from apps/pi-object; needs the image: see e2e/README.md)
//
// Steps: create a throwaway repo, run the container (the agent writes, commits and pushes), check the remote from the
// host, delete the repo and token, and remove the namespace if this run created it. The session log and a result file
// are kept under ~/.dpi/e2e/<run id>/. Nothing else persists.
//
// Secrets: the Cloudflare token is read from .env in this process only. It reaches git through per-command environment
// (GIT_CONFIG_*) and reaches the container through stdin. It never goes on an argv and is never logged.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const IMAGE = "dpi-artifacts-dev:local";
const NAMESPACE = "dpi-e2e";
const BUDGET_MS = 30_000;
const CONTAINER_TIMEOUT_MS = 120_000;
const EXPECTED_FILE = "e2e/hello.txt";
const EXPECTED_CONTENT = "hello from the pi agent in a container\n";
const COMMIT_SUBJECT = "e2e: agent change";

const started = Date.now();
const runId = `e2e-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
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

async function main(): Promise<number> {
  log(`run ${runId}`);
  let createdNamespace = false;
  let repoCreated = false;
  let remote = "";
  let repoToken = "";
  let cloneDir: string | undefined;
  const result: Record<string, unknown> = { runId, image: IMAGE, namespace: NAMESPACE };

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

    // 2. Repo and short-lived repo token.
    t = Date.now();
    const repo = await api("POST", `/${NAMESPACE}/repos`, { name: runId });
    repoCreated = repo.status === 200 || repo.status === 201;
    check("repo created", repoCreated, `HTTP ${repo.status}`);
    if (!repoCreated) throw new Error("repo create failed");
    remote = repo.json.result.remote;
    repoToken = repo.json.result.token;
    log(`remote ${remote}`);
    phase.repo_create_ms = Date.now() - t;

    // 3. Container: the agent writes, commits and pushes; the container removes itself on exit.
    t = Date.now();
    const containerName = runId;
    const run = await proc(
      "container",
      ["run", "--rm", "--init", "--cpus", "2", "--memory", "1G", "--name", containerName, "-i", IMAGE, "/opt/e2e/inside.sh"],
      { stdin: `${remote}\n${repoToken}\n`, timeoutMs: CONTAINER_TIMEOUT_MS },
    );
    phase.container_ms = Date.now() - t;
    writeFileSync(join(logDir, "container.log"), run.out + run.err);
    for (const line of (run.out + run.err).split("\n").filter(Boolean)) log(`  | ${line}`);
    const field = (key: string) => run.out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    const profile = run.out.match(/^PROFILE (.*)$/m)?.[1] ?? "";
    const containerHead = field("CONTAINER_HEAD");
    check("container exited 0", run.code === 0, `exit ${run.code}`);
    check("agent finished", field("AGENT_EXIT") === "0", `AGENT_EXIT=${field("AGENT_EXIT")}`);
    check("seed pushed from container", /^[0-9a-f]{40}$/.test(field("SEED_SHA")));
    check("agent commit pushed from container", /^[0-9a-f]{40}$/.test(containerHead) && containerHead !== field("SEED_SHA"));
    result.profile = profile;
    result.containerHead = containerHead;

    // 4. Host-side verification: the remote itself, read with a token that lives only in this process.
    t = Date.now();
    const lsRemote = await proc("git", ["ls-remote", remote, "refs/heads/main"], { env: gitEnv(repoToken) });
    const remoteHead = lsRemote.out.split("\t")[0] ?? "";
    check("remote main equals the container's HEAD", remoteHead === containerHead, `remote ${remoteHead.slice(0, 12)}`);

    cloneDir = mkdtempSync(join(tmpdir(), "dpi-e2e-clone-"));
    const clone = await proc("git", ["clone", "-q", remote, join(cloneDir, "c")], { env: gitEnv(repoToken) });
    check("host clone of the remote succeeds", clone.code === 0, `exit ${clone.code}`);
    if (clone.code === 0) {
      const c = join(cloneDir, "c");
      let fileText = "";
      try {
        fileText = readFileSync(join(c, EXPECTED_FILE), "utf8");
      } catch {
        fileText = "";
      }
      check("file content matches", fileText === EXPECTED_CONTENT, EXPECTED_FILE);
      const subject = (await proc("git", ["-C", c, "log", "-1", "--format=%s"])).out.trim();
      check("commit subject matches", subject === COMMIT_SUBJECT, JSON.stringify(subject));
      const count = (await proc("git", ["-C", c, "rev-list", "--count", "HEAD"])).out.trim();
      check("history is seed + agent commit", count === "2", `${count} commits`);
    }
    phase.verify_ms = Date.now() - t;
  } catch (e) {
    check("run completed", false, (e as Error).message);
  } finally {
    // 5. Teardown: repo, token, namespace, clone. Then prove the token no longer works.
    const t = Date.now();
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
          const after = await proc("git", ["ls-remote", remote, "refs/heads/main"], { env: gitEnv(repoToken) });
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
    const leftover = (await proc("container", ["list", "-a"])).out.split("\n").filter((l) => l.includes(runId));
    check("no container left behind", leftover.length === 0);
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
  log(`${result.passed ? "E2E PASS" : "E2E FAIL"} ${runId} in ${(total / 1000).toFixed(1)}s; log ${logDir}`);
  return result.passed ? 0 : 1;
}

main().then((code) => process.exit(code));
