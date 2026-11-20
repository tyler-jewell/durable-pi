// The Artifacts e2e, entirely inside the container. The Cloudflare token is a mounted file, never an environment variable.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secret = readFileSync("/run/secrets/cloudflare", "utf8").replace(/\n+$/, "").split("\n");
const token = secret[0];
const account = secret[1];
if (!token || !account) throw new Error("mounted secret needs a token line and an account line");

const runId = process.argv[2] || `e2e-container-${Date.now().toString(36)}`;
const namespace = "dpi-e2e";
const started = Date.now();
const phase = {};
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, json };
}

async function shape() {
  const headers = { authorization: `Bearer ${token}` };
  const [workers, tokens, namespaces] = await Promise.all([
    fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, { headers }).then((r) => r.json()),
    fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens?per_page=50`, { headers }).then((r) => r.json()),
    api("GET", ""),
  ]);
  const names = (rows, key) => (rows ?? []).map((row) => String(row[key] ?? "")).filter(Boolean).sort();
  return JSON.stringify({
    workers: names(workers.result, "id"),
    tokens: names(tokens.result, "name"),
    namespaces: names(namespaces.json.result, "namespace"),
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(opts.stdin ?? "");
  });
}

const before = await shape();
let t = Date.now();
let createdNamespace = false;
const existing = await api("GET", `/${namespace}`);
if (existing.status === 404) {
  const created = await api("POST", "", { namespace, jurisdiction: "us" });
  createdNamespace = created.status === 200 || created.status === 201;
  check("namespace created", createdNamespace, `HTTP ${created.status}`);
} else {
  check("namespace present", existing.status === 200, `HTTP ${existing.status}`);
}
phase.namespace_ms = Date.now() - t;

t = Date.now();
const repo = await api("POST", `/${namespace}/repos`, { name: runId });
const repoCreated = repo.status === 200 || repo.status === 201;
check("repo created", repoCreated, `HTTP ${repo.status}`);
if (!repoCreated) throw new Error("repo create failed");
const remote = repo.json.result.remote;
const repoToken = repo.json.result.token;
phase.repo_create_ms = Date.now() - t;

t = Date.now();
const agent = await run("/opt/e2e/inside.sh", [], { stdin: `${remote}\n${repoToken}\n` });
phase.agent_ms = Date.now() - t;
process.stdout.write(agent.out.split("\n").filter((l) => !l.includes("artifacts.cloudflare.net")).map((l) => `  | ${l}`).join("\n") + "\n");
check("agent run exited 0", agent.code === 0, `exit ${agent.code}`);
check("agent finished", /E2E_AGENT_DONE/.test(agent.out));

t = Date.now();
const cloneDir = mkdtempSync(join(tmpdir(), "dpi-e2e-"));
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repoToken}`,
};
const clone = await run("git", ["clone", "-q", remote, join(cloneDir, "c")], { env: gitEnv });
check("host clone of the remote succeeds", clone.code === 0, `exit ${clone.code}`);
if (clone.code === 0) {
  const text = readFileSync(join(cloneDir, "c", "e2e", "hello.txt"), "utf8");
  check("file content matches", text === "hello from the pi agent in a container\n");
}
phase.verify_ms = Date.now() - t;
rmSync(cloneDir, { recursive: true, force: true });

t = Date.now();
const del = await api("DELETE", `/${namespace}/repos/${runId}`);
check("repo delete accepted", del.status === 202 || del.status === 200, `HTTP ${del.status}`);
let gone = 0;
for (let i = 0; i < 40 && gone !== 404; i++) {
  gone = (await api("GET", `/${namespace}/repos/${runId}`)).status;
  if (gone !== 404) await new Promise((r) => setTimeout(r, 250));
}
check("repo is gone", gone === 404, `HTTP ${gone}`);
const refused = await run("git", ["ls-remote", remote, "refs/heads/main"], { env: gitEnv });
check("token no longer accepted", refused.code !== 0, refused.code === 0 ? "accepted" : "refused");
if (createdNamespace) {
  const delNs = await api("DELETE", `/${namespace}`);
  check("namespace removed", delNs.status === 200 || delNs.status === 204, `HTTP ${delNs.status}`);
}
const after = await shape();
check("workers, tokens, and namespaces unchanged", after === before, after === before ? "same" : "changed");
phase.teardown_ms = Date.now() - t;

const total = Date.now() - started;
const passed = checks.every((c) => c.ok) && total < 30_000;
check("total under 30s", total < 30_000, `${(total / 1000).toFixed(1)}s`);
console.log(JSON.stringify({ passed, total_ms: total, phase }));
process.exit(passed ? 0 : 1);
