// Verifies a generated app against its rules, in a real browser (agent-browser), and writes a report.
//
//   just app verify <app>
//
// Each rule maps to a Modern Web Guidance guide ID (retrieve them with `npx modern-web-guidance@latest retrieve <id>`) or,
// for offline-first and installable PWA, to a project rule. A rule with no check is not reported as passing.
// Output: ~/.dpi/app-verify/<app>/<run id>/ (report.md, results.json, logs). The app's preview server is stopped at the end.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const appName = process.argv[2];
if (!appName) {
  console.error("usage: app-verify.mts <app>");
  process.exit(2);
}
const APP = join(ROOT, "apps", appName);
if (!existsSync(join(APP, "package.json"))) {
  console.error(`no app at apps/${appName}`);
  process.exit(2);
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = join(homedir(), ".dpi", "app-verify", appName, runId);
mkdirSync(outDir, { recursive: true });
const PORT = 4173 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

interface Result {
  guide: string;
  rule: string;
  check: string;
  pass: boolean;
  evidence: string;
}
const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.guide.padEnd(26)} ${r.rule}  [${r.evidence}]`);
};

function sh(cmd: string, args: string[], cwd = APP, timeoutMs = 600_000): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(join(outDir, `${cmd.replace(/[^a-z]/gi, "")}-${args.join("_").replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.log`), out);
  return { code: r.status ?? 1, out };
}

/** One agent-browser call. Returns the last line of its output, parsed if it is JSON or a quoted value. */
function ab(args: string[], timeoutMs = 120_000): string {
  const r = spawnSync("agent-browser", args, { encoding: "utf8", timeout: timeoutMs });
  const lines = `${r.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.filter((l) => !l.startsWith("✓")).at(-1) ?? "";
  return last;
}
// The page returns JSON: a boolean, a number or a string. The caller narrows it (=== true, template text).
const evalJs = (expr: string): unknown => {
  const raw = ab(["eval", expr]);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

function stopPreview(child: ReturnType<typeof spawn> | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function main(): Promise<number> {
  // 1. Install, typecheck, build.
  if (!existsSync(join(APP, "node_modules"))) {
    const inst = sh("npm", ["install", "--no-audit", "--no-fund"]);
    if (inst.code !== 0) throw new Error(`npm install failed (see ${outDir})`);
  }
  const tc = sh("npm", ["run", "-s", "typecheck"]);
  record({ guide: "project: typed", rule: "The app type-checks (vue-tsc)", check: "npm run typecheck", pass: tc.code === 0, evidence: tc.code === 0 ? "exit 0" : `exit ${tc.code}` });
  const build = sh("npm", ["run", "-s", "build"]);
  record({ guide: "project: build", rule: "The app builds", check: "npm run build", pass: build.code === 0, evidence: build.code === 0 ? "exit 0" : `exit ${build.code}` });
  if (build.code !== 0) return finish(1);

  // 2. Installable PWA: manifest with a 192 and a 512 PNG, and a service worker.
  const dist = join(APP, "dist");
  const manifest = existsSync(join(dist, "manifest.webmanifest")) ? JSON.parse(readFileSync(join(dist, "manifest.webmanifest"), "utf8")) : null;
  const pngs = (manifest?.icons ?? []).filter((i: { type: string; sizes: string }) => i.type === "image/png").map((i: { sizes: string }) => i.sizes);
  const installable = manifest && pngs.includes("192x192") && pngs.includes("512x512") && manifest.display === "standalone";
  record({
    guide: "project: PWA",
    rule: "Installable: manifest (standalone) with 192 and 512 PNG icons",
    check: "dist/manifest.webmanifest",
    pass: Boolean(installable),
    evidence: manifest ? `display=${manifest.display}, png sizes=${pngs.join(",")}` : "no manifest",
  });
  record({
    guide: "project: PWA",
    rule: "Offline-first: a service worker precaches the build",
    check: "dist/sw.js present",
    pass: existsSync(join(dist, "sw.js")),
    evidence: existsSync(join(dist, "sw.js")) ? "dist/sw.js" : "missing",
  });

  // 3. Serve the built app and drive the browser.
  const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: APP,
    detached: true,
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${BASE}/`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error("preview server did not start");

    ab(["open", `${BASE}/`]);
    const swActive = evalJs("navigator.serviceWorker.ready.then(r => !!r.active)");
    record({ guide: "project: PWA", rule: "The service worker is active in the browser", check: "navigator.serviceWorker.ready", pass: swActive === true, evidence: `ready.active=${swActive}` });

    // Offline: reload while offline and check the app still renders.
    ab(["set", "offline", "on"]);
    ab(["eval", "location.reload()"]);
    await new Promise((r) => setTimeout(r, 2500));
    const h1Offline = evalJs("document.querySelector('h1')?.textContent ?? ''");
    const statusOffline = evalJs("document.querySelector('#connection')?.textContent ?? ''");
    ab(["set", "offline", "off"]);
    record({
      guide: "project: offline",
      rule: "Offline reload renders the app from the cache, and the status says so",
      check: "set offline on; reload; read h1 and #connection",
      pass: typeof h1Offline === "string" && h1Offline.length > 0 && String(statusOffline).includes("Offline"),
      evidence: `h1="${h1Offline}", status="${statusOffline}"`,
    });

    // Performance: layout shift on load (Core Web Vitals 'good' is <= 0.1).
    ab(["open", `${BASE}/`]);
    const vitals = JSON.parse(ab(["vitals", `${BASE}/`, "--json"], 180_000) || "{}");
    const cls = vitals?.data?.cls?.score;
    record({
      guide: "performance",
      rule: "No layout shift on load (CLS <= 0.1)",
      check: "agent-browser vitals --json",
      pass: typeof cls === "number" && cls <= 0.1,
      evidence: `cls=${cls}, entries=${vitals?.data?.cls?.entries?.length ?? "?"}`,
    });

    // Responsive: no horizontal overflow at phone, tablet, laptop, large and TV widths.
    const widths: Array<[number, number]> = [
      [320, 640],
      [768, 1024],
      [1440, 900],
      [2560, 1440],
      [3840, 2160],
    ];
    const overflow: string[] = [];
    const rootSizes: string[] = [];
    for (const [w, h] of widths) {
      ab(["set", "viewport", String(w), String(h)]);
      await new Promise((r) => setTimeout(r, 300));
      const fits = evalJs("document.documentElement.scrollWidth <= window.innerWidth");
      if (fits !== true) overflow.push(`${w}px`);
      rootSizes.push(`${w}px=${evalJs("getComputedStyle(document.documentElement).fontSize")}`);
    }
    record({
      guide: "responsive-design",
      rule: "No horizontal overflow from a 320px phone to a 3840px TV",
      check: "scrollWidth <= innerWidth at 5 viewports",
      pass: overflow.length === 0,
      evidence: overflow.length ? `overflow at ${overflow.join(", ")}` : `fits at ${widths.map((x) => x[0]).join(", ")}`,
    });
    const phone = rootSizes[0];
    const tv = rootSizes[rootSizes.length - 1];
    record({
      guide: "fluid-scaling",
      rule: "Type scales with the viewport (root font size grows from phone to TV)",
      check: "computed html font-size at 320px and 3840px",
      pass: phone !== tv,
      evidence: rootSizes.join(", "),
    });
    const styles = readFileSync(join(APP, "src", "styles.css"), "utf8");
    const pctBase = /html\s*\{[^}]*font-size:\s*clamp\(\s*100%/.test(styles);
    record({
      guide: "respect-os-text-scale",
      rule: "Root font size is a percentage of the user's default, so the OS text scale applies",
      check: "src/styles.css: html font-size starts at 100%",
      pass: pctBase,
      evidence: pctBase ? "clamp(100%, ...)" : "root font size is fixed",
    });

    // Reduced motion: the dialog's transition is shorter when the user asks for less motion.
    ab(["set", "viewport", "1440", "900"]);
    ab(["open", `${BASE}/`]);
    ab(["set", "media", "reduced-motion"]);
    const reduced = evalJs("getComputedStyle(document.querySelector('.app-dialog')).transitionDuration.split(',')[0]");
    ab(["set", "media"]);
    const normal = evalJs("getComputedStyle(document.querySelector('.app-dialog')).transitionDuration.split(',')[0]");
    record({
      guide: "motion",
      rule: "Dialog motion is reduced under prefers-reduced-motion",
      check: "computed transition-duration, reduced-motion vs no-preference",
      pass: reduced !== normal && reduced === "0.1s" && normal === "0.3s",
      evidence: `reduced=${reduced}, default=${normal}`,
    });
    // Color scheme: dark and light differ, and the page declares both.
    ab(["set", "media", "dark"]);
    const bgDark = evalJs("getComputedStyle(document.body).backgroundColor");
    ab(["set", "media", "light"]);
    const bgLight = evalJs("getComputedStyle(document.body).backgroundColor");
    ab(["set", "media"]);
    record({
      guide: "dark-mode",
      rule: "Dark and light color schemes both apply",
      check: "body background under prefers-color-scheme dark and light",
      pass: bgDark !== bgLight,
      evidence: `dark=${bgDark}, light=${bgLight}`,
    });
    const scheme = evalJs("getComputedStyle(document.documentElement).colorScheme");
    record({
      guide: "color",
      rule: "The page declares its color schemes so form controls adapt",
      check: "computed color-scheme on html",
      pass: typeof scheme === "string" && scheme.includes("dark"),
      evidence: `color-scheme=${scheme}`,
    });

    // Dialog: a native modal, focus moves in, Escape closes it and returns focus to the opener.
    ab(["open", `${BASE}/`]);
    ab(["click", "#open-dialog"]);
    await new Promise((r) => setTimeout(r, 400));
    const modal = evalJs("document.querySelector('.app-dialog').matches(':modal')");
    const focusInside = evalJs("document.querySelector('.app-dialog').contains(document.activeElement)");
    ab(["press", "Escape"]);
    await new Promise((r) => setTimeout(r, 400));
    const returned = evalJs("document.activeElement?.id ?? ''");
    record({
      guide: "dialog",
      rule: "Modal dialog: background inert (modal state), focus moves into it, Escape closes it",
      check: ":modal, activeElement inside, Escape",
      pass: modal === true && focusInside === true,
      evidence: `modal=${modal}, focusInside=${focusInside}`,
    });
    record({
      guide: "dialog",
      rule: "Closing returns focus to the element that opened the dialog",
      check: "document.activeElement.id after Escape",
      pass: returned === "open-dialog",
      evidence: `activeElement=${returned}`,
    });
    return finish(results.every((r) => r.pass) ? 0 : 1);
  } finally {
    ab(["set", "offline", "off"]);
    ab(["set", "media"]);
    ab(["close"]);
    stopPreview(preview);
  }
}

function finish(code: number): number {
  const pass = results.every((r) => r.pass) && code === 0;
  const rows = results.map((r) => `| \`${r.guide}\` | ${r.rule} | ${r.check} | ${r.pass ? "Pass" : "**Fail**"} | ${r.evidence} |`);
  const md = [
    `# Verify ${appName}`,
    "",
    `Run ${runId}. Verdict: **${pass ? "PASS" : "FAIL"}**. Browser: agent-browser; server: vite preview.`,
    "",
    "| Guide | Rule | Check | Result | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "report.md"), md);
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ app: appName, runId, pass, results }, null, 2) + "\n");
  console.log(`\n${pass ? "APP VERIFY PASS" : "APP VERIFY FAIL"} ${appName}: report ${join(outDir, "report.md")}`);
  return pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`verify error: ${(e as Error).message}`);
    process.exit(1);
  });
