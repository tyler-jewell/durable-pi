// Tests for the llama.cpp config: the shared file, the rendered command line and launch agent, and drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argvOf, driftOf, expandHome, parseConfig, parseHosts, plistOf, unknownFlags } from "./llama.mts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const configText = readFileSync(join(repo, "llama", "config.yaml"), "utf8");
const config = parseConfig(configText);
const host = parseHosts(`
host-a:
  binary: /opt/llama/bin/llama-server
  models_dir: ~/models
  replaces: [com.example.old]
  args:
    threads: 4
`)["host-a"];

test("the shared config names no model: the server serves whatever its directory holds", () => {
  assert.doesNotMatch(configText, /\.gguf|Q\d_K|granite|qwen|mistral|gemma|gpt-oss|deepseek|clef|clairic|openjev/i);
});

test("the command line serves a models directory in router mode, bound to loopback", () => {
  const argv = argvOf(config, host);
  assert.equal(argv[0], "/opt/llama/bin/llama-server");
  assert.deepEqual(argv.slice(1, 13), ["--models-dir", join(homedir(), "models"), "--models-max", "1", "--host", "127.0.0.1", "--port", "8080", "--sleep-idle-seconds", "600", "--ctx-size", "16384"]);
  assert.ok(argv.includes("--jinja") && argv.includes("--no-webui") && argv.includes("--no-slots"));
});

test("a host's own args override the shared ones, and false leaves a flag out", () => {
  const argv = argvOf(config, host);
  assert.equal(argv[argv.indexOf("--threads") + 1], "4");
  assert.equal(argv.filter((a) => a === "--threads").length, 1);
  const off = parseConfig(configText.replace("jinja: true", "jinja: false"));
  assert.ok(!argvOf(off, host).includes("--jinja"));
});

test("the config refuses a flag that the structure already sets, and a non-flag name", () => {
  assert.throws(() => parseConfig(configText.replace("args:\n", "args:\n  port: 9\n")), /set by the structure/);
  assert.throws(() => parseConfig(configText.replace("ctx-size", "CtxSize")), /lowercase words/);
});

test("the launch agent runs the same command, logs to the shared file, and escapes its text", () => {
  const argv = argvOf(config, { ...host, args: { note: "a<b&c" } });
  const plist = plistOf(config, argv, "/tmp/llama.log");
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.dpi\.llama-server<\/string>/);
  assert.match(plist, /<string>a&lt;b&amp;c<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/tmp\/llama\.log<\/string>/);
});

test("drift names exactly the flags a running router does not show as configured", () => {
  // The arguments one of the Studio's models reported, before it was brought in line with config.yaml.
  const reported = ["/opt/llama/bin/llama-server", "--host", "127.0.0.1", "--no-webui", "--port", "62397", "--sleep-idle-seconds", "600",
    "--alias", "m", "--ctx-size", "16384", "--cache-ram", "0", "--flash-attn", "auto", "--model", "/x/m.gguf", "--n-gpu-layers", "999",
    "--parallel", "1", "--threads", "8", "--threads-batch", "8"];
  const problems = driftOf(config, host, reported);
  assert.ok(problems.some((p) => p.startsWith("--jinja: missing")), problems.join("; "));
  assert.ok(problems.some((p) => p.startsWith("--no-slots: missing")), problems.join("; "));
  assert.ok(problems.some((p) => p.startsWith("--threads: running 8, config 4")), problems.join("; "));
  assert.ok(!problems.some((p) => p.startsWith("--ctx-size")));
});

test("drift is empty when the running server shows the configured flags", () => {
  const argv = argvOf(config, host);
  assert.deepEqual(driftOf(config, host, argv), []);
});

test("unknownFlags finds a flag the binary's help does not list", () => {
  const help = "  --jinja, --no-jinja   chat templates\n  --ctx-size N   size\n";
  assert.deepEqual(unknownFlags(["/bin/x", "--jinja", "--ctx-size", "4", "--bogus-flag", "1"], help), ["--bogus-flag"]);
});

test("a leading ~ means this machine's home", () => {
  assert.equal(expandHome("~/a/b"), join(homedir(), "a/b"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
});
