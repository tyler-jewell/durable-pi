// The mesh's host list and Cloudflare Access credentials. No dependencies, so the model transport
// (models.ts) and discovery (mesh.ts) can both use it without an import cycle.
//
// Every mesh host is a Cloudflare Tunnel hostname protected by Cloudflare Access. Calls to it carry
// an Access service token (CF-Access-Client-Id / CF-Access-Client-Secret), read from the env var named
// in mesh.json. The token never lives in mesh.json; it is in the environment (see docs/local-factory.md).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MeshHost {
  name: string;
  /** Cloudflare Access-protected Tunnel hostname, e.g. llm-studio.<your-zone>. */
  hostname: string;
  /** Env var holding "client_id:client_secret" of an Access service token for this host. */
  serviceTokenEnv?: string;
  online?: boolean;
}

export interface MeshConfig {
  hosts: MeshHost[];
}

const PKG = fileURLToPath(new URL("..", import.meta.url));
const MESH_FILE = () => process.env.DPI_MCP_MESH ?? join(PKG, "mesh.json");
const ACCESS_FILE = () => process.env.DPI_MCP_ACCESS ?? join(homedir(), ".dpi-mcp", "access.env");

/** Load `KEY=value` lines from the Access token file (mode 0600, outside the repo) into the env,
 *  without overriding anything already set. Keeps secrets out of mesh.json and out of shell history. */
export function loadAccessFile(): void {
  const file = ACCESS_FILE();
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/** Read the mesh file. Keys are snake_case on disk (`service_token_env`), camelCase in code. */
export function loadMeshConfig(): MeshConfig {
  const file = MESH_FILE();
  const path = existsSync(file) ? file : join(PKG, "mesh.example.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { hosts?: Record<string, unknown>[] };
  const hosts = (raw.hosts ?? []).map((h) => ({
    name: String(h.name),
    hostname: String(h.hostname),
    serviceTokenEnv: typeof h.service_token_env === "string" ? h.service_token_env : undefined,
  }));
  return { hosts };
}

/** The two Access service-token headers for a host, or undefined when none is configured. */
export function accessHeaders(host: MeshHost): Record<string, string> | undefined {
  loadAccessFile();
  const value = host.serviceTokenEnv ? process.env[host.serviceTokenEnv] : undefined;
  if (!value) return undefined;
  const [id, secret] = value.split(":", 2);
  if (!id || !secret) return undefined;
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** Access headers for any URL on a mesh host (matched by hostname). Empty for non-mesh URLs,
 *  so local and cloud calls are unchanged. This is what every model call uses. */
export function accessHeadersFor(url: string): Record<string, string> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return {};
  }
  const host = loadMeshConfig().hosts.find((h) => h.hostname === hostname);
  return (host && accessHeaders(host)) || {};
}
