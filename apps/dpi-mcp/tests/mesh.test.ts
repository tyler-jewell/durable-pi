import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessHeaders, listMeshHosts } from "../src/mesh.js";

test("listMeshHosts reads Cloudflare hosts from the mesh config (no tailscale)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-mesh-"));
  const file = join(dir, "mesh.json");
  writeFileSync(
    file,
    JSON.stringify({
      hosts: [
        { name: "studio", hostname: "studio.jewell-labs.com", service_token_env: "CF_ACCESS_STUDIO" },
        { name: "macbook-pro", hostname: "mbp.jewell-labs.com", service_token_env: "CF_ACCESS_MBP" },
      ],
    }),
  );
  const prev = process.env.DPI_MCP_MESH;
  process.env.DPI_MCP_MESH = file;
  try {
    const hosts = listMeshHosts();
    const names = hosts.map((h) => h.name);
    assert.ok(names.includes("studio"));
    assert.ok(names.includes("macbook-pro"), "finds the MacBook Pro host over Cloudflare");
    assert.equal(hosts.find((h) => h.name === "macbook-pro")?.hostname, "mbp.jewell-labs.com");
  } finally {
    process.env.DPI_MCP_MESH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accessHeaders turns a service-token env value into the Access header pair", () => {
  const prev = process.env.CF_ACCESS_STUDIO;
  process.env.CF_ACCESS_STUDIO = "client-id-123:client-secret-456";
  try {
    const headers = accessHeaders({ name: "studio", hostname: "studio.jewell-labs.com", serviceTokenEnv: "CF_ACCESS_STUDIO" });
    assert.deepEqual(headers, { "CF-Access-Client-Id": "client-id-123", "CF-Access-Client-Secret": "client-secret-456" });
  } finally {
    process.env.CF_ACCESS_STUDIO = prev;
  }
  assert.equal(accessHeaders({ name: "studio", hostname: "x", serviceTokenEnv: "CF_ACCESS_UNSET" }), undefined);
});
