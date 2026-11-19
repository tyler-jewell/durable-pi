// One driver per device kind. Drivers know kinds and services, never machines:
// every machine-specific fact comes from dpi-network.yaml.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DeviceKind } from "../api.js";
import { DpiClient } from "../client.js";
import { DEFAULT_CONTAINER_IMAGE, syncConfigToRegistry, type NetDevice, type NetworkConfig } from "./config.js";
import { NetworkRegistry } from "./registry.js";
import { exeDev, remote, rsync, run, shPath, sleep } from "./ops.js";

export interface DriverContext {
  config: NetworkConfig;
  registry: NetworkRegistry;
  args: string[];
  log: (line: string) => void;
}

export type Verb =
  | "up"
  | "create"
  | "provision"
  | "deploy"
  | "env"
  | "service"
  | "expose"
  | "register"
  | "restart"
  | "down"
  | "logs"
  | "destroy"
  | "rotate";

export type Driver = Partial<Record<Verb, (device: NetDevice, ctx: DriverContext) => Promise<void>>>;

export const SERVICE_LABEL = "dev.dpi.backend";
export const SYSTEMD_UNIT = "dpi-backend";
const NVM_INSTALL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh";

/** Resolve a `~/…` path for inside an apple container (containers run as root). */
function containerAbs(p: string) {
  return p === "~" ? "/root" : p.startsWith("~/") ? `/root${p.slice(1)}` : p;
}

/** Run a POSIX shell script inside an apple container. */
function containerExec(device: NetDevice, script: string, options: { echo?: boolean; timeoutMs?: number } = {}) {
  return run("container", ["exec", device.id, "sh", "-c", script], options);
}

/** Run a script locally, in an apple container, or on the device over ssh. */
function exec(device: NetDevice, script: string, options: { echo?: boolean; timeoutMs?: number } = {}) {
  if (device.kind === "local")
    return run("sh", ["-s"], {
      ...options,
      stdin: `set -e\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true\n${script}`,
    });
  if (device.kind === "apple-container") return containerExec(device, script, options);
  return remote(device, script, options);
}

function localEnv(config: NetworkConfig): Record<string, string> {
  const file = join(config.root, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// ------------------------------------------------------------------ shared steps

async function facts(device: NetDevice) {
  const out = (
    await exec(device, `echo "HOME=$HOME"; echo "USER=$(id -un)"; echo "NODE=$(nvm which ${device.node} 2>/dev/null || command -v node || true)"`)
  ).stdout;
  const get = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { home: get("HOME"), user: get("USER"), node: get("NODE") };
}

const abs = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);

async function provision(device: NetDevice, ctx: DriverContext) {
  ctx.log(`provision ${device.id}: nvm + node ${device.node}`);
  const apt =
    device.kind === "exe-dev"
      ? `if command -v apt-get >/dev/null; then sudo -n apt-get update -qq >/dev/null && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git rsync curl build-essential ripgrep >/dev/null; fi\n`
      : "";
  const result = await exec(
    device,
    `${apt}if [ ! -s "$NVM_DIR/nvm.sh" ]; then curl -fsSL ${NVM_INSTALL} | PROFILE=/dev/null bash >/dev/null; fi
. "$NVM_DIR/nvm.sh"
nvm install ${device.node} >/dev/null 2>&1
echo "node: $(nvm which ${device.node})"`,
    { timeoutMs: 900_000 },
  );
  ctx.log(result.stdout.trim());
}

async function deploy(device: NetDevice, ctx: DriverContext) {
  const code = device.codeDir.replace(/^~\//, "");
  ctx.log(`deploy ${device.id}: sync apps/dpi-backend + apps/dpi-sdk → ${device.codeDir}/apps`);
  await exec(
    device,
    `mkdir -p "${shPath(device.codeDir)}/apps" "${shPath(device.codeDir)}/e2e" "${shPath(device.homeDir)}" && chmod 700 "${shPath(device.homeDir)}"`,
  );
  await rsync(device, ["apps/dpi-backend", "apps/dpi-sdk"], `${code}/apps/`, ctx.config.root);
  ctx.log(`deploy ${device.id}: npm ci`);
  await exec(
    device,
    `cd "${shPath(device.codeDir)}/apps/dpi-backend" && nvm exec ${device.node} npm ci --no-audit --no-fund --loglevel=error >/dev/null && echo installed`,
    { timeoutMs: 900_000 },
  );
}

/** Write <home>/backend.env, keeping an existing token unless rotating. Secrets travel on stdin. */
async function writeEnv(device: NetDevice, ctx: DriverContext, rotate = false) {
  const local = localEnv(ctx.config);
  const missing = device.envKeys.filter((k) => !(local[k] ?? process.env[k]));
  if (missing.length) ctx.log(`warning: ${missing.join(", ")} not found in ${join(ctx.config.root, ".env")} or the environment`);
  const home = shPath(device.homeDir);
  const body = [
    `DPI_DEVICE_NAME=${device.id}`,
    `DPI_PORT=${device.port}`,
    `DPI_HOST=${device.host}`,
    `DPI_START_DIRS=${device.startDirs.join(":")}`,
    ...device.envKeys.flatMap((k) => {
      const v = local[k] ?? process.env[k];
      return v && !/[\n\r]/.test(v) ? [`${k}=${v}`] : [];
    }),
    ...Object.entries(device.env).map(([k, v]) => `${k}=${v}`),
  ].join("\n");
  const mkStartDirs = device.startDirs.map((r) => `mkdir -p "${shPath(r)}"`).join("\n");
  await exec(
    device,
    `umask 077
mkdir -p "${home}"
F="${home}/backend.env"
TOKEN=$(grep '^DPI_TOKEN=' "$F" 2>/dev/null | head -1 | cut -d= -f2- || true)
if [ -z "$TOKEN" ] || [ "${rotate ? 1 : 0}" = 1 ]; then TOKEN="dpi_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\\n')"; fi
printf 'DPI_TOKEN=%s\\n' "$TOKEN" > "$F.tmp"
cat >> "$F.tmp" <<'DPI_ENV_EOF'
${body}
DPI_ENV_EOF
mv "$F.tmp" "$F"
chmod 600 "$F"
${mkStartDirs}
echo "env ok"`,
  );
  ctx.log(`env ${device.id}: ${device.homeDir}/backend.env written (${rotate ? "token rotated" : "token kept or created"})`);
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/__([A-Z_]+)__/g, (m, key: string) => {
    if (!(key in values)) throw Error(`Template placeholder ${m} has no value`);
    return values[key];
  });
}

async function installService(device: NetDevice, ctx: DriverContext) {
  if (!device.service) throw Error(`${device.id} has no service in dpi-network.yaml`);
  const f = await facts(device);
  if (!f.node) throw Error(`${device.id}: node ${device.node} not found; run: just net step provision ${device.id}`);
  const app = device.kind === "local" ? join(ctx.config.root, "apps/dpi-backend") : `${abs(device.codeDir, f.home)}/apps/dpi-backend`;
  const dpiHome = abs(device.homeDir, f.home);
  const nodeDir = f.node.replace(/\/node$/, "");
  const values = {
    LABEL: SERVICE_LABEL,
    UNIT: SYSTEMD_UNIT,
    NODE: f.node,
    APP: app,
    HOME: f.home,
    USER: f.user,
    DPI_HOME: dpiHome,
    LOG: `${dpiHome}/backend.log`,
    PATH: `${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const deployDir = join(ctx.config.root, "apps/dpi-backend/deploy");
  if (device.service === "launchd") {
    // A headless VM has no Aqua session, so its LaunchAgent must live in the user domain, not gui/.
    const domain = device.kind === "macos-vm" ? "user/$(id -u)" : "gui/$(id -u)";
    const plist = fill(readFileSync(join(deployDir, "dpi-backend.plist"), "utf8"), values);
    await exec(
      device,
      `P="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$P" <<'DPI_PLIST_EOF'
${plist}
DPI_PLIST_EOF
launchctl bootout ${domain}/${SERVICE_LABEL} 2>/dev/null || true
for i in 1 2 3 4 5; do launchctl bootstrap ${domain} "$P" 2>/dev/null && break; sleep 1; done
launchctl print ${domain}/${SERVICE_LABEL} >/dev/null && echo "launchd ok"`,
    );
  } else {
    const unit = fill(readFileSync(join(deployDir, "dpi-backend.service"), "utf8"), values);
    await exec(
      device,
      `sudo -n tee /etc/systemd/system/${SYSTEMD_UNIT}.service >/dev/null <<'DPI_UNIT_EOF'
${unit}
DPI_UNIT_EOF
sudo -n systemctl daemon-reload
sudo -n systemctl enable ${SYSTEMD_UNIT} >/dev/null 2>&1
sudo -n systemctl restart ${SYSTEMD_UNIT}
echo "systemd ok"`,
    );
  }
  ctx.log(`service ${device.id}: ${device.service} installed and started`);
}

async function serviceCommand(device: NetDevice, action: "restart" | "down") {
  if (device.service === "launchd") {
    const domain = device.kind === "macos-vm" ? "user/$(id -u)" : "gui/$(id -u)";
    return exec(
      device,
      action === "restart"
        ? `launchctl kickstart -k ${domain}/${SERVICE_LABEL}`
        : `launchctl bootout ${domain}/${SERVICE_LABEL} 2>/dev/null || true`,
    );
  }
  if (device.service === "systemd") return exec(device, `sudo -n systemctl ${action === "restart" ? "restart" : "stop"} ${SYSTEMD_UNIT}`);
  throw Error(`${device.id} has no service; it runs with \`just backend run\``);
}

async function register(device: NetDevice, ctx: DriverContext) {
  syncConfigToRegistry(ctx.config, ctx.registry);
  const token = (await exec(device, `grep '^DPI_TOKEN=' "${shPath(device.homeDir)}/backend.env" | head -1 | cut -d= -f2-`)).stdout.trim();
  if (!token) throw Error(`${device.id}: no DPI_TOKEN in ${device.homeDir}/backend.env; run: just net step env ${device.id}`);
  ctx.registry.setToken(device.id, token);
  ctx.registry.forgetUid(device.id);
  ctx.log(`register ${device.id}: token stored in ${ctx.registry.path}`);
}

export async function waitOnline(device: NetDevice, ctx: DriverContext, timeoutMs = 90_000) {
  const token = ctx.registry.get(device.id)?.token;
  if (!token) throw Error(`${device.id} has no token; run: just net register ${device.id}`);
  const client = new DpiClient(device.url, token);
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const info = await client.device({ timeoutMs: 5000 });
      ctx.log(`online ${device.id}: ${device.url} (${info.name}, uid ${info.uid}, ${info.models.length} models)`);
      return info;
    } catch (e) {
      last = (e as Error).message;
      await sleep(2000);
    }
  }
  throw Error(`${device.id} did not come online at ${device.url}: ${last}`);
}

async function logs(device: NetDevice, ctx: DriverContext) {
  const n = Number(ctx.args[0] ?? 80) || 80;
  const out = await exec(device, `tail -n ${n} "${shPath(device.homeDir)}/backend.log" 2>/dev/null || echo "(no log yet at ${device.homeDir}/backend.log)"`);
  process.stdout.write(out.stdout);
}

// ------------------------------------------------------------------ drivers

const sshDriver: Driver = {
  provision,
  deploy,
  env: (d, ctx) => writeEnv(d, ctx),
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await serviceCommand(d, "restart");
    await register(d, ctx);
  },
  service: installService,
  register,
  restart: async (d, ctx) => {
    await serviceCommand(d, "restart");
    ctx.log(`restart ${d.id}: done`);
  },
  down: async (d, ctx) => {
    await serviceCommand(d, "down");
    ctx.log(`down ${d.id}: stopped`);
  },
  logs,
  async up(d, ctx) {
    await provision(d, ctx);
    await deploy(d, ctx);
    await writeEnv(d, ctx);
    await installService(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

async function exeVms(): Promise<string[]> {
  const out = await exeDev<{ vms?: { vm_name?: string; name?: string; dns_name?: string }[] }>(["ls"]);
  return (out.vms ?? []).map((v) => v.vm_name ?? v.name ?? (v.dns_name ?? "").replace(/\.exe\.xyz$/, ""));
}

async function exeCreate(device: NetDevice, ctx: DriverContext) {
  const vm = device.vm!;
  if ((await exeVms()).includes(vm)) {
    ctx.log(`create ${device.id}: VM ${vm} already exists`);
  } else {
    const c = device.create ?? {};
    ctx.log(`create ${device.id}: ssh exe.dev new --name=${vm}`);
    await exeDev(
      [
        "new",
        `--name=${vm}`,
        ...(c.cpu ? [`--cpu=${c.cpu}`] : []),
        ...(c.memory ? [`--memory=${c.memory}`] : []),
        ...(c.disk ? [`--disk=${c.disk}`] : []),
      ],
      300_000,
    );
  }
  for (let i = 0; i < 40; i++) {
    const ok = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", device.ssh!, "echo READY"], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    if (ok.stdout.includes("READY")) return ctx.log(`create ${device.id}: ssh ${device.ssh} ready`);
    await sleep(3000);
  }
  throw Error(`${device.id}: ${device.ssh} never accepted ssh`);
}

async function exeExpose(device: NetDevice, ctx: DriverContext) {
  await exeDev(["share", "port", device.vm!, String(device.port)]);
  await exeDev(["share", "set-public", device.vm!]);
  ctx.log(`expose ${device.id}: ${device.url} → :${device.port}, public (the bearer token is the gate)`);
}

async function exeDestroy(device: NetDevice, ctx: DriverContext) {
  const vm = device.vm!;
  if (!(await exeVms()).includes(vm)) return ctx.log(`destroy ${device.id}: VM ${vm} does not exist`);
  if (!ctx.args.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Destroy exe.dev VM ${vm} and its disk? Type the VM name to confirm: `);
    rl.close();
    if (answer.trim() !== vm) return ctx.log("destroy: cancelled");
  }
  await exeDev(["rm", vm], 120_000);
  ctx.registry.forgetUid(device.id);
  ctx.log(`destroy ${device.id}: VM ${vm} removed`);
}

const exeDevDriver: Driver = {
  ...sshDriver,
  create: exeCreate,
  expose: exeExpose,
  destroy: exeDestroy,
  async up(d, ctx) {
    await exeCreate(d, ctx);
    await provision(d, ctx);
    await deploy(d, ctx);
    await writeEnv(d, ctx);
    await installService(d, ctx);
    await exeExpose(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

const localDriver: Driver = {
  env: (d, ctx) => writeEnv(d, ctx),
  register,
  logs,
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await register(d, ctx);
    ctx.log("restart the local backend to use the new token");
  },
  service: installService,
  restart: async (d, ctx) => {
    await serviceCommand(d, "restart");
    ctx.log(`restart ${d.id}: done`);
  },
  down: async (d, ctx) => {
    await serviceCommand(d, "down");
    ctx.log(`down ${d.id}: stopped`);
  },
  async up(d, ctx) {
    await writeEnv(d, ctx);
    await register(d, ctx);
    if (d.service) {
      await installService(d, ctx);
      await waitOnline(d, ctx);
    } else ctx.log(`up ${d.id}: env ready. Start it with: just backend run   (it reads ${d.homeDir}/backend.env)`);
  },
};

// ------------------------------------------------------------------ apple container (the macOS `container` CLI)

async function containerCreate(device: NetDevice, ctx: DriverContext) {
  const exists = await run("container", ["inspect", device.id], { allowFail: true });
  if (exists.code === 0) {
    let state = "";
    try {
      state = (JSON.parse(exists.stdout)[0] as { status?: { state?: string } }).status?.state ?? "";
    } catch {}
    if (state === "running") return ctx.log(`create ${device.id}: container already running`);
    ctx.log(`create ${device.id}: container exists (${state || "stopped"}); starting it`);
    await run("container", ["start", device.id]);
    return;
  }
  ctx.log(`create ${device.id}: container run ${device.image ?? DEFAULT_CONTAINER_IMAGE}`);
  await run(
    "container",
    [
      "run", "-d", "--name", device.id,
      "-p", `${device.port}:${device.port}`,
      "-m", device.memory ?? "2048M",
      "-c", String(device.cpus ?? 2),
      device.image ?? DEFAULT_CONTAINER_IMAGE,
      "sleep", "infinity",
    ],
    { timeoutMs: 300_000 },
  );
}

async function containerDeploy(device: NetDevice, ctx: DriverContext) {
  const code = containerAbs(device.codeDir);
  const tgz = `/tmp/dpi-apps-${device.id}.tgz`;
  await containerExec(device, `mkdir -p "${code}/apps" "${code}/e2e" "${containerAbs(device.homeDir)}" && chmod 700 "${containerAbs(device.homeDir)}"`);
  ctx.log(`deploy ${device.id}: package apps/dpi-backend + apps/dpi-sdk`);
  await run(
    "tar",
    ["-czf", tgz, "-C", "apps", "--exclude=node_modules", "--exclude=.data", "--exclude=.durable-pi", "--exclude=dist", "--exclude=*.log", "--exclude=.DS_Store", "dpi-backend", "dpi-sdk"],
    { cwd: ctx.config.root, timeoutMs: 600_000 },
  );
  await run("container", ["cp", tgz, `${device.id}:/tmp/apps.tgz`], { timeoutMs: 600_000 });
  ctx.log(`deploy ${device.id}: npm ci`);
  await containerExec(
    device,
    `tar -xzf /tmp/apps.tgz -C "${code}/apps" && rm -f /tmp/apps.tgz && cd "${code}/apps/dpi-backend" && npm ci --no-audit --no-fund --loglevel=error`,
    { timeoutMs: 900_000 },
  );
  try {
    unlinkSync(tgz);
  } catch {}
}

async function containerProvision(device: NetDevice, ctx: DriverContext) {
  ctx.log(`provision ${device.id}: apt-get install git`);
  await containerExec(
    device,
    `apt-get update -qq >/dev/null && apt-get install -y -qq git ca-certificates >/dev/null && git --version`,
    { timeoutMs: 300_000 },
  );
}

async function containerStart(device: NetDevice, ctx: DriverContext) {
  const code = containerAbs(device.codeDir);
  const log = `${containerAbs(device.homeDir)}/backend.log`;
  // Stop any previous backend first; a stale lock is reclaimed by the new process (its pid is the lock's first field).
  await containerExec(
    device,
    `PID=$(cat "${containerAbs(device.homeDir)}/backend/catalog.sqlite.lock" 2>/dev/null || true)
PID="\${PID%% *}"
[ -n "$PID" ] && kill "$PID" 2>/dev/null || true
pkill -f 'src/main.ts' 2>/dev/null || true
pkill -f 'node_modules/.bin/tsx' 2>/dev/null || true
sleep 1`,
  );
  await run("container", ["exec", "-d", device.id, "sh", "-c", `cd "${code}/apps/dpi-backend" && exec npm start >> "${log}" 2>&1`]);
  ctx.log(`start ${device.id}: backend started`);
}

async function containerRestart(device: NetDevice, ctx: DriverContext) {
  await run("container", ["stop", device.id]);
  await run("container", ["start", device.id]);
  await containerStart(device, ctx);
  ctx.log(`restart ${device.id}: done`);
}

const appleContainerDriver: Driver = {
  create: containerCreate,
  provision: containerProvision,
  deploy: containerDeploy,
  env: (d, ctx) => writeEnv(d, ctx),
  register,
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await containerRestart(d, ctx);
    await register(d, ctx);
  },
  restart: containerRestart,
  down: async (d, ctx) => {
    await run("container", ["stop", d.id]);
    ctx.log(`down ${d.id}: stopped`);
  },
  logs,
  destroy: async (d, ctx) => {
    await run("container", ["rm", "-f", d.id], { allowFail: true });
    ctx.log(`destroy ${d.id}: removed`);
  },
  async up(d, ctx) {
    await containerCreate(d, ctx);
    await containerProvision(d, ctx);
    await containerDeploy(d, ctx);
    await writeEnv(d, ctx);
    await containerStart(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

// ------------------------------------------------------------------ headless macOS VM (Lima, vz driver)

async function limaInstances() {
  const r = await run("limactl", ["list", "--format", "json"], { allowFail: true });
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]) as { name: string; status: string }[];
  } catch {
    return [];
  }
}

/** Install nvm + node without git: a fresh macOS VM has no Xcode CLT, and nvm's install.sh needs git. */
async function macosProvision(device: NetDevice, ctx: DriverContext) {
  ctx.log(`provision ${device.id}: nvm (curl tarball, no git) + node ${device.node}`);
  const result = await exec(
    device,
    `if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  mkdir -p "$NVM_DIR"
  curl -fsSL https://github.com/nvm-sh/nvm/archive/refs/tags/v0.40.3.tar.gz | tar -xz -C "$NVM_DIR" --strip-components=1
fi
. "$NVM_DIR/nvm.sh"
nvm install ${device.node} >/dev/null 2>&1
echo "node: $(nvm which ${device.node})"`,
    { timeoutMs: 900_000 },
  );
  ctx.log(result.stdout.trim());
}

async function limaCreate(device: NetDevice, ctx: DriverContext) {
  const existing = (await limaInstances()).find((i) => i.name === device.id);
  if (!existing) {
    ctx.log(`create ${device.id}: limactl start template://macos-27 (downloads + installs macOS; slow the first time)`);
    await run(
      "limactl",
      [
        "start", "--name", device.id,
        "--cpus", String(device.cpus ?? 2),
        "--memory", device.memory ?? "4GiB",
        "--disk", String(device.disk ?? 40),
        "--set", `.portForwards = [{"guestPort": ${device.port}, "hostPort": ${device.port}}]`,
        "template://macos-27",
      ],
      { timeoutMs: 3_600_000 },
    );
  } else if (existing.status !== "Running") {
    ctx.log(`create ${device.id}: starting existing VM`);
    await run("limactl", ["start", device.id], { timeoutMs: 600_000 });
  } else {
    ctx.log(`create ${device.id}: VM already running`);
  }
}

function limaSshConfig(device: NetDevice) {
  return join(homedir(), ".lima", device.id, "ssh.config");
}

async function macosTunnel(device: NetDevice) {
  await macosStopTunnel(device);
  // Lima's vz portForwards do not publish for macOS guests, so forward over ssh.
  await run("ssh", ["-F", limaSshConfig(device), "-f", "-N", "-L", `127.0.0.1:${device.port}:127.0.0.1:${device.port}`, `lima-${device.id}`]);
}

async function macosStopTunnel(device: NetDevice) {
  await run("pkill", ["-f", `127.0.0.1:${device.port}:127.0.0.1:${device.port}`], { allowFail: true });
}

async function macosStart(device: NetDevice, ctx: DriverContext) {
  await exec(
    device,
    `mkdir -p "${shPath(device.homeDir)}"
nohup sh -c 'cd "${shPath(device.codeDir)}/apps/dpi-backend" && exec npm start' >> "${shPath(device.homeDir)}/backend.log" 2>&1 < /dev/null &`,
  );
  await macosTunnel(device);
  ctx.log(`service ${device.id}: backend started + ssh tunnel to 127.0.0.1:${device.port} (headless VM has no Aqua session for launchd)`);
}

async function macosStop(device: NetDevice) {
  await exec(device, `pkill -f 'src/main.ts' 2>/dev/null || true`);
  await macosStopTunnel(device);
}

const macosVmDriver: Driver = {
  create: limaCreate,
  provision: macosProvision,
  deploy,
  env: (d, ctx) => writeEnv(d, ctx),
  service: macosStart,
  register,
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await macosStop(d);
    await macosStart(d, ctx);
    await register(d, ctx);
  },
  restart: async (d, ctx) => {
    await macosStop(d);
    await macosStart(d, ctx);
    ctx.log(`restart ${d.id}: done`);
  },
  down: async (d, ctx) => {
    await macosStop(d);
    ctx.log(`down ${d.id}: stopped`);
  },
  logs,
  destroy: async (d, ctx) => {
    await macosStopTunnel(d);
    await run("limactl", ["delete", "--force", d.id], { allowFail: true });
    ctx.log(`destroy ${d.id}: removed`);
  },
  async up(d, ctx) {
    await limaCreate(d, ctx);
    await macosProvision(d, ctx);
    await deploy(d, ctx);
    await writeEnv(d, ctx);
    await macosStart(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

const urlDriver: Driver = {
  async register(d, ctx) {
    syncConfigToRegistry(ctx.config, ctx.registry);
    const i = ctx.args.indexOf("--token");
    const token = i >= 0 ? ctx.args[i + 1] : d.tokenEnv ? process.env[d.tokenEnv] : undefined;
    if (!token) throw Error(`${d.id} is a url device: pass --token <token>${d.tokenEnv ? ` or set ${d.tokenEnv}` : ""}`);
    ctx.registry.setToken(d.id, token);
    ctx.registry.forgetUid(d.id);
    ctx.log(`register ${d.id}: token stored`);
  },
  async up(d, ctx) {
    await urlDriver.register!(d, ctx);
    await waitOnline(d, ctx);
  },
};

export const drivers: Record<DeviceKind, Driver> = {
  local: localDriver,
  ssh: sshDriver,
  "exe-dev": exeDevDriver,
  "apple-container": appleContainerDriver,
  "macos-vm": macosVmDriver,
  url: urlDriver,
};

export const defaultHome = () => homedir();
