// Artifacts is the git server. A push mints a short-lived write token, pushes with a Bearer header, then
// updates the public main branch. The token is never logged, and the public update is the only GitHub call.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const NAMESPACE = "dpi";
export const BASELINE = "durable-pi";
const TOKEN_TTL_SECONDS = 900;

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

export interface ArtifactsClient {
  fetch: typeof fetch;
  git(args: string[], env: NodeJS.ProcessEnv): Promise<GitResult>;
  origin(): Promise<string>;
  head(): Promise<string>;
}

export function liveClient(cwd: string): ArtifactsClient {
  return {
    fetch,
    async git(args, env) {
      try {
        const { stdout, stderr } = await exec("git", args, { cwd, env, timeout: 120_000 });
        return { code: 0, out: stdout, err: stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
      }
    },
    async origin() {
      const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd });
      return stdout.trim();
    },
    async head() {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
      return stdout.trim();
    },
  };
}

interface Api {
  status: number;
  json: { success?: boolean; result?: Record<string, unknown>; errors?: { message?: string }[] };
}

function redact(text: string, secret: string): string {
  const hidden = secret ? text.split(secret).join("<token>") : text;
  return hidden.replace(/[0-9a-f]{32}/g, "<id>").replace(/https:\/\/[^/\s]+artifacts\.cloudflare\.net\S*/g, "<artifacts-remote>");
}

async function api(client: ArtifactsClient, account: string, token: string, method: string, path: string, body?: unknown): Promise<Api> {
  const res = await client.fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Api["json"] = {};
  try {
    json = JSON.parse(text) as Api["json"];
  } catch {
    json = { errors: [{ message: `not json (${res.status})` }] };
  }
  return { status: res.status, json };
}

/** The baseline repo exists. A missing repo is imported once from the public origin. */
export async function ensureBaseline(client: ArtifactsClient, account: string, token: string, origin: string): Promise<void> {
  const present = await api(client, account, token, "GET", `/namespaces/${NAMESPACE}`);
  if (present.status === 404) {
    const created = await api(client, account, token, "POST", "/namespaces", { namespace: NAMESPACE, jurisdiction: "us" });
    if (created.status !== 200 && created.status !== 201) throw new Error(`namespace was not created (${created.status})`);
  } else if (present.status !== 200) {
    throw new Error(`namespace was not readable (${present.status})`);
  }
  const repo = await api(client, account, token, "GET", `/namespaces/${NAMESPACE}/repos/${BASELINE}`);
  if (repo.status === 200) return;
  if (repo.status !== 404) throw new Error(`baseline was not readable (${repo.status})`);
  if (!origin.startsWith("https://")) throw new Error("the public origin must be an https remote before it can seed the baseline");
  const imported = await api(client, account, token, "POST", `/namespaces/${NAMESPACE}/repos/${BASELINE}/import`, { url: origin, branch: "main" });
  if (imported.status !== 200 && imported.status !== 201 && imported.status !== 202) {
    throw new Error(`baseline import failed (${imported.status})`);
  }
  for (let i = 0; i < 20; i++) {
    const again = await api(client, account, token, "GET", `/namespaces/${NAMESPACE}/repos/${BASELINE}`);
    if (again.status === 200) return;
    if (again.status !== 404 && again.status !== 409) throw new Error(`baseline import did not settle (${again.status})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("baseline import did not settle");
}

export interface PushResult {
  namespace: string;
  repo: string;
  head: string;
  mirrored: boolean;
  mirrorDetail: string;
}

/** Push HEAD to the Artifacts baseline, then update the public main branch. */
export async function pushBaseline(client: ArtifactsClient, env: NodeJS.ProcessEnv, mirror = true): Promise<PushResult> {
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ADMIN_TOKEN || "";
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and a Cloudflare token are required");
  const origin = await client.origin();
  const head = await client.head();
  await ensureBaseline(client, account, token, origin);
  const minted = await api(client, account, token, "POST", `/namespaces/${NAMESPACE}/tokens`, { repo: BASELINE, scope: "write", ttl: TOKEN_TTL_SECONDS });
  const repoToken = String(minted.json.result?.plaintext ?? "");
  const remote = String(minted.json.result?.remote ?? "");
  if (!repoToken) throw new Error(`write token was not minted (${minted.status})`);
  const repo = await api(client, account, token, "GET", `/namespaces/${NAMESPACE}/repos/${BASELINE}`);
  const gitRemote = remote || String(repo.json.result?.remote ?? "");
  if (!gitRemote) throw new Error("the baseline has no remote");
  const pushed = await client.git(["push", gitRemote, "HEAD:main"], {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repoToken}`,
    GIT_CONFIG_KEY_1: "protocol.version",
    GIT_CONFIG_VALUE_1: "1",
  });
  if (pushed.code !== 0) throw new Error(`artifacts push failed: ${redact(`${pushed.err} ${pushed.out}`, repoToken).slice(-300)}`);
  if (!mirror) return { namespace: NAMESPACE, repo: BASELINE, head, mirrored: false, mirrorDetail: "not requested" };
  const mirrored = await client.git(["push", origin, "HEAD:main"], { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0" });
  if (mirrored.code !== 0) {
    return { namespace: NAMESPACE, repo: BASELINE, head, mirrored: false, mirrorDetail: redact(`${mirrored.err} ${mirrored.out}`, repoToken).slice(-200) };
  }
  return { namespace: NAMESPACE, repo: BASELINE, head, mirrored: true, mirrorDetail: "public main updated" };
}
