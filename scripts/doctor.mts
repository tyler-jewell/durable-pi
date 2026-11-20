// Report missing local runtime state and loose permissions. It prints paths and status words, never file contents.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.DPI_DOCTOR_HOME ?? homedir();
const required = [
  join(home, ".dpi", "backend.env"),
  join(home, ".dpi", "backend", "catalog.sqlite"),
  join(home, ".dpi", "pi-object.token"),
  join(home, ".dpi-mcp", "access.env"),
];

let failed = false;
for (const item of required) {
  const shown = item.replace(home, "~");
  if (!existsSync(item)) {
    console.log(`MISSING: ${shown}`);
    failed = true;
    continue;
  }
  const mode = statSync(item).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.log(`LOOSE: ${shown}`);
    failed = true;
    continue;
  }
  console.log(`OK: ${shown}`);
}

const overlay = process.env.DPI_DOCTOR_OVERLAY;
if (overlay && existsSync(overlay)) {
  let host = "";
  let sawVersion = false;
  const missing: string[] = [];
  for (const line of readFileSync(overlay, "utf8").split("\n")) {
    const named = /^([a-z0-9-]+):\s*$/.exec(line);
    if (named) {
      if (host && !sawVersion) missing.push(host);
      host = named[1];
      sawVersion = false;
      continue;
    }
    const version = /^\s+llama_version:\s+(\S+)/.exec(line);
    if (version && host) {
      sawVersion = true;
      try {
        const ran = spawnSync("llama-server", ["--version"], { encoding: "utf8" });
        const actual = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
        if (!actual.includes(version[1])) {
          console.log(`MISMATCH: llama_version for ${host}`);
          failed = true;
        }
      } catch {
        console.log(`UNCHECKED: llama-server is not on PATH for ${host}`);
      }
    }
  }
  if (host && !sawVersion) missing.push(host);
  for (const name of missing) {
    console.log(`MISSING: llama_version for ${name}`);
    failed = true;
  }
}

if (failed) {
  console.log("doctor failed: required local state is missing or readable by another user");
  process.exit(1);
}
console.log("doctor passed");
