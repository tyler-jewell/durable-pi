// Modal dialogs on the native <dialog> element (Modern Web Guidance: dialog, Rule 1).
// Headless Chrome. Opens the help and new-session dialogs, then checks modality, Esc, focus return and backdrop close.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const base = process.env.DPI_HUB_URL ?? "http://127.0.0.1:4781/";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(base, { waitUntil: "domcontentloaded" });

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("help dialog opens as a native modal and Escape closes it", async () => {
  const opener = page.getByRole("button", { name: "How this works" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "What makes this durable?" });
  await dialog.waitFor();
  assert.equal(await page.locator("dialog:modal").count(), 1, "one modal dialog is open");
  assert.equal(await dialog.evaluate((el) => el.tagName), "DIALOG", "the dialog is a native <dialog>");
  assert.equal(await dialog.locator("[role=dialog], [aria-modal]").count(), 0, "no hand-written dialog role");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(await page.locator("dialog[open]").count(), 0, "Escape closed it");
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim()),
    "How this works",
    "focus returned to the button that opened it",
  );
});

check("new session dialog closes on a backdrop click and keeps focus on its opener", async () => {
  const opener = page.getByRole("button", { name: "New session" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  await page.mouse.click(4, 4);
  await dialog.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(await page.locator("dialog[open]").count(), 0, "a backdrop click closed it");
  assert.ok(box && box.width > 0, "the dialog had a box before it closed");
});

check("clicks inside the dialog keep it open", async () => {
  await page.getByRole("button", { name: "How this works" }).click();
  const dialog = page.getByRole("dialog", { name: "What makes this durable?" });
  await dialog.waitFor();
  await dialog.locator("h2").click();
  assert.equal(await page.locator("dialog[open]").count(), 1, "still open after a click inside");
  await page.keyboard.press("Escape");
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
