// Artifacts REST access for the e2e and the inventory. The token is read from .env in this process and is never printed.
//
// Endpoints (Artifacts REST API, 2026): namespaces create/get/list/delete; repos create/list/delete; repo tokens.
// Namespace jurisdiction is set on create ("us" or "eu") and cannot be changed afterwards.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NAMESPACE = "dpi-e2e";
/** The namespace jurisdiction for e2e data. Test data, but pinned: the data stays in the United States. */
export const JURISDICTION = "us";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const env = loadEnv();
export const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) throw new Error(".env needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
export const artifactsBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces`;

export async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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

/** Every namespace on the account, with its repos (each listed page by page). */
export async function inventory(): Promise<Array<{ namespace: string; jurisdiction: string | null; repos: string[] }>> {
  const listed = await api("GET", "");
  if (listed.status !== 200) throw new Error(`namespace list HTTP ${listed.status}`);
  const out: Array<{ namespace: string; jurisdiction: string | null; repos: string[] }> = [];
  for (const ns of listed.json.result as Array<{ namespace: string; jurisdiction?: string | null }>) {
    const repos: string[] = [];
    for (let page = 1; ; page++) {
      const r = await api("GET", `/${ns.namespace}/repos?page=${page}&per_page=100`);
      if (r.status !== 200) throw new Error(`repo list ${ns.namespace} HTTP ${r.status}`);
      repos.push(...(r.json.result as Array<{ name: string }>).map((x) => x.name));
      if (page >= (r.json.result_info?.total_pages ?? 1)) break;
    }
    out.push({ namespace: ns.namespace, jurisdiction: ns.jurisdiction ?? null, repos });
  }
  return out;
}

/** Repos on the account: the namespace list's own repo_count, one call. */
export async function repoCount(): Promise<number> {
  const listed = await api("GET", "");
  if (listed.status !== 200) throw new Error(`namespace list HTTP ${listed.status}`);
  return (listed.json.result as Array<{ repo_count?: number }>).reduce((n, ns) => n + (ns.repo_count ?? 0), 0);
}
