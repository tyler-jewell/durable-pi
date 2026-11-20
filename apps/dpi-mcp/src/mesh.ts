// Mesh discovery over Cloudflare: probe every mesh host (from mesh.json) for a local model server.
// Every probe goes through Cloudflare Tunnel + Access with the host's service token. No tailscale,
// no private IPs, no hardcoded host list.
import { probeHost, type HostCapability } from "./capabilities.js";
import { accessHeaders, loadMeshConfig, type MeshHost } from "./mesh-config.js";

export type { MeshHost } from "./mesh-config.js";
export { loadMeshConfig, accessHeaders } from "./mesh-config.js";
export const listMeshHosts = (): MeshHost[] => loadMeshConfig().hosts;

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
