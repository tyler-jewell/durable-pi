// Headless proof that a push shows the approval notice and a click lands on the question.
// Browser mode is a normal tab. PWA mode is Chromium's app window, which reports display-mode standalone.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "../dpi-playground/package.json"));
const { chromium } = require("playwright");

const preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4178", "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const base = "http://127.0.0.1:4178/";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview did not start")), 20_000);
  preview.stdout.on("data", (chunk) => {
    if (String(chunk).includes("4178")) {
      clearTimeout(timer);
      resolve();
    }
  });
  preview.on("exit", (code) => reject(new Error(`preview exited ${code}`)));
});

const shots = [];
async function run(mode) {
  const browser = mode === "pwa" ? null : await chromium.launch({ channel: "chrome", headless: true });
  const context = mode === "pwa"
    ? await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "dpi-pwa-")), {
        channel: "chrome",
        headless: true,
        viewport: { width: 390, height: 844 },
        args: [`--app=${base}`],
      })
    : await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["notifications"]);
  const page = mode === "pwa" ? context.pages()[0] ?? await context.newPage() : await context.newPage();
  await page.goto(base);
  await page.waitForSelector("[data-approval]");
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready);
  const standalone = await page.evaluate(() => matchMedia("(display-mode: standalone)").matches);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "push", title: "Approval waiting", body: "Publish the release notes?", url: "/#approval" });
  });
  await page.waitForSelector("[data-notice]");
  const shot = join(tmpdir(), `dpi-notice-${mode}.png`);
  await page.screenshot({ path: shot });
  shots.push(shot);
  await page.click("[data-notice-open]");
  await page.waitForSelector("#approval button.primary");
  const opened = join(tmpdir(), `dpi-approval-${mode}.png`);
  await page.screenshot({ path: opened });
  shots.push(opened);
  const question = await page.locator("#approval").innerText();
  if (!question.includes("approve publishing") && !question.includes("Approve")) throw new Error(`${mode}: approval question not visible`);
  await page.click("#approval button.primary");
  await page.waitForSelector("text=Approved by you");
  console.log(`PASS ${mode} standalone=${standalone} shot=${shot}`);
  await context.close();
  if (browser) await browser.close();
}

try {
  await run("browser");
  await run("pwa");
  console.log(shots.join("\n"));
} finally {
  preview.kill("SIGTERM");
}
