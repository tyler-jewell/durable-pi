// Light browser smoke for a generated app: build, serve with vite preview, and drive a
// headless browser (agent-browser) through a few render checks. Shared by the dpi-mcp `test`
// tool; the full Modern Web Guidance audit lives in app-verify.mts.
//
//   npx tsx scripts/app-smoke.mts <app>
//
// Prints one line: `SMOKE PASS <detail>` or `SMOKE FAIL <detail>`. Exit 0/1.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2];
if (!app) {
  console.error("usage: app-smoke.mts <app>");
  process.exit(2);
}
const APP = join(ROOT, "apps", app);
if (!existsSync(join(APP, "package.json"))) {
  console.error(`no app at apps/${app}`);
  process.exit(2);
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: APP, encoding: "utf8", timeout: 90_000 });
const ab = (args: string[]) => {
  const r = spawnSync("agent-browser", args, { encoding: "utf8", timeout: 60_000 });
  const last = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
};

const build = sh("npm", ["run", "-s", "build"]);
if (build.status !== 0) {
  console.log(`SMOKE FAIL build: ${((build.stderr ?? build.stdout) ?? "").slice(0, 400)}`);
  process.exit(1);
}

const port = 4173 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const preview = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: APP,
  detached: true,
  stdio: "ignore",
});

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${base}/`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 400));
  }
  if (!up) throw new Error("preview server did not start");

  ab(["open", `${base}/`]);
  const title = ab(["eval", "document.title"]);
  const h1 = ab(["eval", "document.querySelector('h1')?.textContent ?? ''"]);
  ab(["set", "viewport", "320", "640"]);
  const phone = ab(["eval", "document.documentElement.scrollWidth <= window.innerWidth"]);
  ab(["set", "viewport", "1440", "900"]);
  const desktop = ab(["eval", "document.documentElement.scrollWidth <= window.innerWidth"]);
  ab(["set", "offline", "on"]);
  ab(["eval", "location.reload()"]);
  await new Promise((r) => setTimeout(r, 1000));
  const offlineH1 = ab(["eval", "document.querySelector('h1')?.textContent ?? ''"]);
  ab(["set", "offline", "off"]);

  const ok =
    typeof title === "string" && title.length > 0 &&
    typeof h1 === "string" && h1.length > 0 &&
    phone === true && desktop === true &&
    typeof offlineH1 === "string" && offlineH1.length > 0;
  const detail = `title="${title}", h1="${h1}", phoneFits=${phone}, desktopFits=${desktop}, offlineH1="${offlineH1}"`;
  console.log(`${ok ? "SMOKE PASS" : "SMOKE FAIL"} ${detail}`);
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log(`SMOKE FAIL ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-preview.pid!, "SIGTERM");
  } catch {
    /* already gone */
  }
  spawnSync("agent-browser", ["close"], { cwd: APP });
}
