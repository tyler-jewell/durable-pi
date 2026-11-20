import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessHeaders, accessHeadersFor, loadMeshConfig } from "../src/mesh-config.js";

function withMesh(hosts: object[], fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "dpi-mesh-"));
  const file = join(dir, "mesh.json");
  writeFileSync(file, JSON.stringify({ hosts }));
  const prev = process.env.DPI_MCP_MESH;
  process.env.DPI_MCP_MESH = file;
  try {
    fn();
  } finally {
    process.env.DPI_MCP_MESH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadMeshConfig reads Cloudflare hosts and maps service_token_env (snake_case on disk)", () => {
  withMesh(
    [
      { name: "studio", hostname: "studio.example.com", service_token_env: "CF_ACCESS_STUDIO" },
      { name: "macbook-pro", hostname: "mbp.example.com", service_token_env: "CF_ACCESS_MBP" },
    ],
    () => {
      const hosts = loadMeshConfig().hosts;
      assert.deepEqual(hosts.map((h) => h.name), ["studio", "macbook-pro"]);
      assert.equal(hosts[0].serviceTokenEnv, "CF_ACCESS_STUDIO");
    },
  );
});

test("accessHeaders turns a service-token env value into the Access header pair", () => {
  const prev = process.env.CF_ACCESS_TEST_HOST;
  process.env.CF_ACCESS_TEST_HOST = "client-id-123:client-secret-456";
  try {
    const headers = accessHeaders({ name: "studio", hostname: "studio.example.com", serviceTokenEnv: "CF_ACCESS_TEST_HOST" });
    assert.deepEqual(headers, { "CF-Access-Client-Id": "client-id-123", "CF-Access-Client-Secret": "client-secret-456" });
  } finally {
    process.env.CF_ACCESS_TEST_HOST = prev;
  }
  assert.equal(accessHeaders({ name: "studio", hostname: "x", serviceTokenEnv: "CF_ACCESS_UNSET_XYZ" }), undefined);
});

test("accessHeadersFor attaches the token only to the mesh host's own URLs", () => {
  withMesh([{ name: "studio", hostname: "studio.example.com", service_token_env: "CF_ACCESS_TEST_URL" }], () => {
    const prev = process.env.CF_ACCESS_TEST_URL;
    process.env.CF_ACCESS_TEST_URL = "id.access:secret";
    try {
      assert.deepEqual(accessHeadersFor("https://studio.example.com/v1/models"), { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" });
      assert.deepEqual(accessHeadersFor("https://api.openai.com/v1/models"), {}, "no token leaks to other hosts");
      assert.deepEqual(accessHeadersFor("http://127.0.0.1:8080/health"), {}, "local URLs are unchanged");
    } finally {
      process.env.CF_ACCESS_TEST_URL = prev;
    }
  });
});

test("the shipped mesh.json is ignored by git; the example is the committed template", () => {
  assert.ok(loadMeshConfig().hosts.length >= 1);
});
