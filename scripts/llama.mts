// The llama.cpp server of every host that serves local models, from one definition: llama/config.yaml (shared) and
// llama/hosts.yaml (per host, not committed). Commands:
//   render <host>           the launch agent (plist) for a host
//   argv <host>             the server command line, one argument per line
//   check                   both files are valid, and every flag exists in the local llama-server
//   drift <host> <url>      the flags a running server reports (its /v1/models) against the config. For a host behind
//                           Access, set DPI_LLAMA_ACCESS_ENV to the name of the variable that holds its service token
//   apply <host>            write this machine's launch agent, unload the labels it replaces, and start it
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type FlagValue = string | number | boolean;

export interface LlamaConfig {
  label: string;
  host: string;
  port: number;
  models_max: number;
  sleep_idle_seconds: number;
  log: string;
  args: Record<string, FlagValue>;
}

export interface HostConfig {
  hostname?: string;
  /** The host's home folder, which `~` means in its paths. Defaults to this machine's. */
  home: string;
  binary: string;
  models_dir: string;
  replaces: string[];
  args: Record<string, FlagValue>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LLAMA_DIR = join(ROOT, "llama");

/** `~` at the start of a path becomes the host's home folder, so one file names a folder on every host. */
export function expandHome(path: string, home = homedir()): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

const fail = (message: string): never => {
  throw Error(message);
};

const isFlagValue = (v: unknown): v is FlagValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function flagsOf(where: string, raw: unknown): Record<string, FlagValue> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${where} must be a map of flags`);
  const out: Record<string, FlagValue> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`${where}.${name}: a flag name is lowercase words joined by dashes`);
    if (!isFlagValue(value)) fail(`${where}.${name} must be text, a number, or true/false`);
    out[name] = value as FlagValue;
  }
  return out;
}

/** Validate the shared file. Throws with the first problem. */
export function parseConfig(text: string): LlamaConfig {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : fail(`config.yaml: ${k} must be text`));
  const int = (k: string, min: number): number => {
    const v = raw[k];
    return Number.isInteger(v) && (v as number) >= min ? (v as number) : fail(`config.yaml: ${k} must be an integer of at least ${min}`);
  };
  const config: LlamaConfig = {
    label: str("label"),
    host: str("host"),
    port: int("port", 1),
    models_max: int("models_max", 1),
    sleep_idle_seconds: int("sleep_idle_seconds", -1),
    log: str("log"),
    args: flagsOf("config.yaml: args", raw.args),
  };
  if (!/^[a-z0-9.-]+$/.test(config.label)) fail("config.yaml: label must be a launchd label");
  for (const reserved of ["models-dir", "models-max", "host", "port", "sleep-idle-seconds"]) {
    if (reserved in config.args) fail(`config.yaml: args.${reserved} is set by the structure above, not by args`);
  }
  return config;
}

/** Validate the per-host overlay. */
export function parseHosts(text: string): Record<string, HostConfig> {
  const raw = (parse(text) ?? {}) as Record<string, Record<string, unknown>>;
  const hosts: Record<string, HostConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null) fail(`hosts.yaml: ${name} must be a map`);
    const where = `hosts.yaml: ${name}`;
    const text = (k: string): string => (typeof entry[k] === "string" && entry[k] ? (entry[k] as string) : fail(`${where}.${k} must be text`));
    const replaces = entry.replaces ?? [];
    if (!Array.isArray(replaces) || replaces.some((r) => typeof r !== "string")) fail(`${where}.replaces must be a list of labels`);
    hosts[name] = {
      hostname: entry.hostname === undefined ? undefined : text("hostname"),
      home: entry.home === undefined ? homedir() : text("home"),
      binary: text("binary"),
      models_dir: text("models_dir"),
      replaces: replaces as string[],
      args: flagsOf(`${where}.args`, entry.args),
    };
  }
  return hosts;
}

export function hostOf(hosts: Record<string, HostConfig>, name: string): HostConfig {
  const host = hosts[name];
  if (!host) fail(`no host "${name}" in llama/hosts.yaml (known: ${Object.keys(hosts).join(", ") || "none"})`);
  return host;
}

/** Router-level flags. A running router does not echo them in a model's arguments, so drift cannot compare them. */
export const ROUTER_FLAGS = new Set(["models-dir", "models-max", "models-memory-margin", "models-preset", "models-autoload", "no-models-autoload"]);

/** The flags a value turns into: `--name value`, the bare `--name`, or nothing for false. */
function flagTokens(args: Record<string, FlagValue>): string[] {
  return Object.entries(args).flatMap(([name, value]) => {
    if (value === false) return [];
    if (value === true) return [`--${name}`];
    return [`--${name}`, String(value)];
  });
}

/** The server command line for a host. The shared args apply first; the host's own args override them. */
export function argvOf(config: LlamaConfig, host: HostConfig): string[] {
  return [
    host.binary,
    "--models-dir",
    expandHome(host.models_dir, host.home),
    "--models-max",
    String(config.models_max),
    "--host",
    config.host,
    "--port",
    String(config.port),
    "--sleep-idle-seconds",
    String(config.sleep_idle_seconds),
    ...flagTokens({ ...config.args, ...host.args }),
  ];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launch agent: starts at login, restarts if it stops, and logs to the shared file. */
export function plistOf(config: LlamaConfig, argv: string[], logPath: string): string {
  const items = argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** The argument list a running server reports: its `status.args` in router mode, and `[]` for a single-model server. */
export function reportedFlags(args: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(args[i], next);
      i++;
    } else out.set(args[i], true);
  }
  return out;
}

/** Flags the config sets that a running server does not report the same way. Empty means no drift. */
export function driftOf(config: LlamaConfig, host: HostConfig, reported: string[]): string[] {
  const seen = reportedFlags(reported);
  const expected = new Map<string, string | true>();
  const shared = { ...config.args, ...host.args };
  for (const [name, value] of Object.entries(shared)) {
    if (value === false || ROUTER_FLAGS.has(name)) continue;
    expected.set(`--${name}`, value === true ? true : String(value));
  }
  expected.set("--sleep-idle-seconds", String(config.sleep_idle_seconds));
  const problems: string[] = [];
  for (const [flag, want] of expected) {
    if (!seen.has(flag)) problems.push(`${flag}: missing (config ${want === true ? "bare flag" : want})`);
    else if (seen.get(flag) !== want) problems.push(`${flag}: running ${String(seen.get(flag))}, config ${want === true ? "bare flag" : want}`);
  }
  for (const [flag, value] of Object.entries(shared)) {
    if (value === false && !ROUTER_FLAGS.has(flag) && seen.has(`--${flag}`)) problems.push(`--${flag}: running, config leaves it out`);
  }
  return problems;
}

/** Each flag the rendered command uses must appear in the binary's own help. Returns the unknown ones. */
export function unknownFlags(argv: string[], help: string): string[] {
  return argv
    .filter((a) => a.startsWith("--"))
    .filter((flag) => !new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|,|$)`, "m").test(help));
}

function loadConfigs(): { config: LlamaConfig; hosts: Record<string, HostConfig>; hostsPresent: boolean } {
  const config = parseConfig(readFileSync(join(LLAMA_DIR, "config.yaml"), "utf8"));
  const file = join(LLAMA_DIR, "hosts.yaml");
  if (!existsSync(file)) return { config, hosts: {}, hostsPresent: false };
  return { config, hosts: parseHosts(readFileSync(file, "utf8")), hostsPresent: true };
}

/** The Access service token for a host, from the variable named by the caller (its value is `id:secret`). */
function accessHeaders(envName: string): Record<string, string> {
  if (!envName) return {};
  const file = join(homedir(), ".dpi-mcp", "access.env");
  if (!existsSync(file)) return {};
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${envName}=`));
  if (!line) return {};
  const [id, secret] = line.slice(envName.length + 1).split(":", 2);
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

async function drift(config: LlamaConfig, host: HostConfig, url: string, envName: string): Promise<void> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/models`, { headers: accessHeaders(envName), redirect: "error" });
  if (!res.ok) fail(`${url}/v1/models answered ${res.status}`);
  const body = (await res.json()) as { data?: { id: string; status?: { args?: string[] } }[] };
  const models = body.data ?? [];
  const withArgs = models.filter((m) => m.status?.args?.length);
  if (!withArgs.length) {
    console.log(`drift: ${url} reports no launch arguments (a single-model server, or no status); nothing to compare`);
    return;
  }
  // Every model reports the router's arguments. The first one is compared; a difference shows in all of them.
  const problems = driftOf(config, host, withArgs[0].status!.args!);
  console.log(`drift: ${models.length} model(s) at ${url}`);
  if (problems.length === 0) console.log("drift: none; the running server matches llama/config.yaml");
  else for (const p of problems) console.log(`drift: ${p}`);
  if (problems.length) process.exitCode = 1;
}

function check(config: LlamaConfig, hosts: Record<string, HostConfig>, hostsPresent: boolean): void {
  console.log(`check: config.yaml valid (${Object.keys(config.args).length} flags)`);
  if (!hostsPresent) console.log("check: llama/hosts.yaml is absent here (copy hosts.example.yaml to set this machine's paths)");
  let bad = false;
  for (const [name, host] of Object.entries(hosts)) {
    const dir = expandHome(host.models_dir, host.home);
    if (!existsSync(dir)) console.log(`check: ${name}: models_dir ${dir} does not exist here`);
    if (!existsSync(host.binary)) {
      console.log(`check: ${name}: ${host.binary} is not on this machine; its flags were not checked`);
      continue;
    }
    const help = execFileSync(host.binary, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const unknown = unknownFlags(argvOf(config, host), help);
    if (unknown.length) {
      bad = true;
      console.log(`check: ${name}: ${host.binary} does not accept ${unknown.join(", ")}`);
    } else console.log(`check: ${name}: every flag is accepted by ${host.binary}`);
  }
  if (bad) process.exitCode = 1;
}

function apply(config: LlamaConfig, name: string, host: HostConfig): void {
  if (process.platform !== "darwin") fail("apply writes a launchd agent; it runs on macOS only");
  // The launch agent is written to this machine, so the entry must name the machine it belongs to.
  const here = hostname().split(".")[0];
  if (!host.hostname) fail(`hosts.yaml: ${name} needs hostname (this machine is "${here}") before apply can write its launch agent`);
  if (host.hostname !== here) fail(`hosts.yaml says ${name} is "${host.hostname}"; this machine is "${here}". Run apply on that machine.`);
  if (!existsSync(host.binary)) fail(`${host.binary} does not exist on this machine`);
  const uid = process.getuid?.() ?? 501;
  const agents = join(homedir(), "Library", "LaunchAgents");
  const logPath = expandHome(config.log, host.home);
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(agents, { recursive: true });
  const unload = (label: string) => {
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
    } catch {
      // Not loaded: nothing to unload.
    }
  };
  for (const label of host.replaces) {
    unload(label);
    const old = join(agents, `${label}.plist`);
    if (existsSync(old)) renameSync(old, `${old}.replaced`);
    console.log(`apply: replaced ${label} (its plist is kept as ${label}.plist.replaced)`);
  }
  unload(config.label);
  const plist = join(agents, `${config.label}.plist`);
  if (existsSync(plist)) renameSync(plist, `${plist}.replaced`);
  writeFileSync(plist, plistOf(config, argvOf(config, host), logPath));
  // launchd can refuse a bootstrap while the job it just unloaded is still tearing down, so retry briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "pipe" });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      execFileSync("sleep", ["2"]);
    }
  }
  console.log(`apply: ${config.label} is running from ${plist}; log: ${logPath}`);
}

async function main(): Promise<void> {
  const [cmd, name, url] = process.argv.slice(2);
  const { config, hosts, hostsPresent } = loadConfigs();
  switch (cmd) {
    case "render": {
      const host = hostOf(hosts, name ?? fail("usage: render <host>"));
      process.stdout.write(plistOf(config, argvOf(config, host), expandHome(config.log, host.home)));
      break;
    }
    case "argv":
      for (const a of argvOf(config, hostOf(hosts, name ?? fail("usage: argv <host>")))) console.log(a);
      break;
    case "check":
      check(config, hosts, hostsPresent);
      break;
    case "drift":
      if (!name || !url) fail("usage: drift <host> <url>");
      await drift(config, hostOf(hosts, name), url, process.env.DPI_LLAMA_ACCESS_ENV ?? "");
      break;
    case "apply":
      apply(config, name ?? fail("usage: apply <host>"), hostOf(hosts, name));
      break;
    default:
      fail("usage: llama.mts render|argv|check|drift|apply ...");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
