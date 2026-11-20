// Mesh discovery over Cloudflare: enumerate the Zero Trust hosts from mesh.json (a list of
// Cloudflare Access-protected Tunnel hostnames) and probe each for a local model server with an
// Access service token. No tailscale, no private IPs — every host is reached through Cloudflare
// Tunnel + Cloudflare Access.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { probeHost, type HostCapability } from "./capabilities.js";

export interface MeshHost {
  name: string;
  /** Cloudflare Access-protected Tunnel hostname (e.g. studio.jewell-labs.com). */
  hostname: string;
  /** Env var whose value is "client_id:client_secret" of an Access service token. */
  serviceTokenEnv?: string;
  online?: boolean;
}

export interface MeshConfig {
  hosts: MeshHost[];
}

const MESH_FILE = () => process.env.DPI_MCP_MESH ?? resolve("mesh.json");

export function loadMeshConfig(): MeshConfig {
  const file = MESH_FILE();
  const fallback = existsSync(file) ? file : resolve("mesh.example.json");
  const raw = JSON.parse(readFileSync(fallback, "utf8")) as Partial<MeshConfig>;
  return { hosts: Array.isArray(raw.hosts) ? raw.hosts : [] };
}

export function listMeshHosts(): MeshHost[] {
  return loadMeshConfig().hosts;
}

/** The two Access service-token headers, or undefined when no token is configured for the host. */
export function accessHeaders(host: MeshHost): Record<string, string> | undefined {
  const env = host.serviceTokenEnv;
  const value = env ? process.env[env] : undefined;
  if (!value) return undefined;
  const [id, secret] = value.split(":", 2);
  if (!id || !secret) return undefined;
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

export interface MeshModelDiscovery {
  host: MeshHost;
  address?: string;
  models: HostCapability["models"];
  error?: string;
}

/** Probe every Cloudflare host for local LLMs / decision models. A host with no model server (or
 *  no authorized service token) is still reported — the zero system must see the whole mesh. */
export async function discoverMeshModels(timeoutMs = 5000): Promise<MeshModelDiscovery[]> {
  const out: MeshModelDiscovery[] = [];
  for (const host of listMeshHosts()) {
    const target = `https://${host.hostname}`;
    const cap = await probeHost(host.name, target, timeoutMs, accessHeaders(host));
    host.online = cap.reachable;
    out.push({ host, address: cap.models.length ? target : undefined, models: cap.models, error: cap.models.length ? undefined : cap.error });
  }
  return out;
}
