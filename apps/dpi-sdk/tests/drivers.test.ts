import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNetworkConfig } from "../src/node/config.js";
import { drivers, type DriverContext } from "../src/node/drivers.js";
import type { NetworkRegistry } from "../src/node/registry.js";

test("restart and down on a device with no service say so, and run nothing on the host", async () => {
  const config = parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: nobody@invalid.example\n    service: systemd\n    url: http://x");
  const device = { ...config.devices.a, service: undefined };
  const ctx: DriverContext = { config, registry: {} as NetworkRegistry, args: [], log: () => {} };
  await assert.rejects(drivers.ssh.restart!(device, ctx), /a has no service; it runs with `just backend run`/);
  await assert.rejects(drivers.ssh.down!(device, ctx), /a has no service/);
});
