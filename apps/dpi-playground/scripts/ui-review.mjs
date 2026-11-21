// One script for the whole UI review: the hub at four widths, six states each. It captures a screenshot, measures layout,
// targets, text, focus and color scheme, runs axe, and writes a findings file and a report grouped by guide.
// Output goes to the device state directory (not the repo): <DPI_HOME>/ui-review/<run>/.
//
//   node scripts/ui-review.mjs [--url http://127.0.0.1:4781/] [--only desktop,mobile-small] [--out <dir>]
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = arg("--url", "http://127.0.0.1:4781/");
const only = arg("--only", "").split(",").filter(Boolean);
// The OS text setting, as the browser applies it to the root font size (respect-os-text-scale). 1 is the default.
const textScale = Number(arg("--text-scale", "1"));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = arg("--out", join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "ui-review", runId));
mkdirSync(outDir, { recursive: true });

// Four widths: desktop, tablet, a large phone and a small phone.
const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900, touch: false },
  { id: "tablet", width: 834, height: 1112, touch: true },
  { id: "mobile-large", width: 430, height: 932, touch: true },
  { id: "mobile-small", width: 320, height: 568, touch: true },
];
const STATES = ["home", "network", "inspector", "new-session", "composer-focus", "extend", "keyboard"];

const axeSource = readFileSync(join(dirname(require.resolve("axe-core")), "axe.min.js"), "utf8");

// The guide each check comes from (retrieve with: npx modern-web-guidance@latest retrieve "<id>").
const GUIDE = {
  overflow: "responsive-design",
  "content-box": "form-factor-adaptation",
  target: "form-factor-adaptation",
  "tiny-text": "typography",
  "px-text": "respect-os-text-scale",
  "text-clip": "typography",
  "focus-ring": "accessibility",
  "color-scheme": "dark-mode",
  dialog: "dialog",
  squeezed: "typography",
  obscured: "accessibility",
  truncated: "typography",
  "axe": "accessibility",
};
const FIX = {
  overflow: "Let flex/grid children shrink (min-inline-size: 0) and wrap long text (overflow-wrap: anywhere). Nothing may extend past the viewport.",
  "content-box": "Keep the element inside the viewport: constrain its width to 100% and let its contents wrap or scroll inside their own container.",
  target: "Make the control at least 24x24 CSS px (44x44 on coarse pointers) with min-block-size / min-inline-size, or extend its hit area with a pseudo-element.",
  "tiny-text": "Do not render text below 12px. Use rem-based sizes with a floor.",
  "px-text": "Size type in rem (or clamp() with a rem term) so the OS text scale applies.",
  "text-clip": "Let the text wrap or ellipsize inside its box instead of being cut off.",
  "focus-ring": "Give :focus-visible an explicit outline with at least 3:1 contrast.",
  "color-scheme": "Declare color-scheme on :root so native controls and scrollbars follow the theme.",
  dialog: "Use the native <dialog> with showModal(), not a div overlay with role=dialog.",
  obscured: "Give fixed bars room: scroll-padding on the scroll container, equal to the bar height plus its safe area, so a focused control scrolls clear of it.",
  squeezed: "Give the text room: let its container take the space (min-inline-size: 0 on flex items, or let the row wrap) before a word is cut to a letter.",
  truncated: "Do not hide most of a label behind an ellipsis: wrap it onto two lines, or move the detail into a title or the inspector.",
};

const findings = [];

// Static: font sizes written in px do not follow the OS text scale (respect-os-text-scale). Counted per file.
const SRC = join(here, "../apps/dpi-playground-fe/src");
function pxFontSizes() {
  const out = [];
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".css"))) {
    const text = readFileSync(join(SRC, name), "utf8");
    const count = [...text.matchAll(/font-size:\s*\d+(\.\d+)?px/g)].length;
    if (count) out.push({ file: name, count });
  }
  return out;
}
const add = (f) => findings.push({ ...f, guide: GUIDE[f.check] ?? f.guide ?? "accessibility" });

// Measured in the page. Everything returned is plain data.
function measure() {
  const vw = document.documentElement.clientWidth;
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.placeholder || el.name || el.tagName).trim().replace(/\s+/g, " ").slice(0, 48);
  const sel = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 4) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      else if (e.classList.length) p += "." + [...e.classList].slice(0, 2).join(".");
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const out = { scrollWidth: document.documentElement.scrollWidth, vw, overflow: [], targets: [], tinyText: [], clipped: [], squeezed: [], truncated: [], colorScheme: getComputedStyle(document.documentElement).colorScheme, modal: document.querySelectorAll("dialog:modal").length };
  const coarse = matchMedia("(pointer: coarse)").matches;
  const min = coarse ? 44 : 24;
  for (const el of document.querySelectorAll("body *")) {
    // Screen-reader text is clipped on purpose: a 1px box or a zero clip rect is not a visible label.
    if (!vis(el) || el.closest(".sr-only")) continue;
    if (el.getBoundingClientRect().width <= 1.5 || getComputedStyle(el).clip === "rect(0px, 0px, 0px, 0px)") continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && r.width < vw * 3 && !el.closest("[data-scroll-x]")) {
      const scrolled = [...(function* () { let p = el.parentElement; while (p) { yield p; p = p.parentElement; } })()].some((p) => /(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && p.clientWidth < vw);
      if (!scrolled) out.overflow.push({ sel: sel(el), label: label(el), right: Math.round(r.right), vw });
    }
    // A checkbox or radio wrapped in a label is hit through the label (Form Factor guide), so the label is measured instead.
    const wrapped = (el.matches("input[type=checkbox], input[type=radio]")) && el.closest("label");
    const interactive = !wrapped && el.matches("button, a[href], select, input, textarea, [role=button], [role=tab], [role=switch]");
    if (interactive && (r.width < min - 0.5 || r.height < min - 0.5) && el.offsetParent !== null) {
      out.targets.push({ sel: sel(el), label: label(el), w: Math.round(r.width), h: Math.round(r.height), min });
    }
    if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) out.tinyText.push({ sel: sel(el), label: label(el), px });
      const cs = getComputedStyle(el);
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ");
      if (cs.overflow === "hidden" && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && r.width > 0) {
        out.clipped.push({ sel: sel(el), label: label(el), by: el.scrollWidth - el.clientWidth });
      }
      // Squeezed: a text box so narrow that most of its words cannot show (Form Factor: never squished to near zero).
      const fs = parseFloat(cs.fontSize);
      const longest = Math.max(0, ...text.split(/\s+/).map((w) => w.length));
      if (text.length > 6 && r.width < fs * 3 && el.parentElement && el.parentElement.getBoundingClientRect().width > fs * 6) {
        out.squeezed.push({ sel: sel(el), label: label(el), w: Math.round(r.width) });
      }
      // Truncated: an ellipsis that hides most of the text.
      if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth * 2.5 && el.clientWidth > 0) {
        out.truncated.push({ sel: sel(el), label: label(el), shown: Math.round((el.clientWidth / el.scrollWidth) * 100) });
      }
    }
  }
  return out;
}

async function measureAndAxe(page, viewport, state) {
  const m = await page.evaluate(measure);
  const at = { viewport: viewport.id, state };
  if (m.scrollWidth > m.vw + 1) add({ ...at, check: "overflow", where: "document", detail: `page is ${m.scrollWidth}px wide in a ${m.vw}px viewport`, fix: FIX.overflow });
  for (const o of m.overflow.slice(0, 6)) add({ ...at, check: "overflow", where: o.sel, detail: `${o.label} reaches x=${o.right} (viewport ${o.vw})`, fix: FIX.overflow });
  for (const t of m.targets.slice(0, 40)) add({ ...at, check: "target", where: t.sel, detail: `${t.label}: ${t.w}x${t.h}px, needs ${t.min}px`, fix: FIX.target });
  for (const t of m.tinyText.slice(0, 10)) add({ ...at, check: "tiny-text", where: t.sel, detail: `${t.label}: ${t.px}px`, fix: FIX["tiny-text"] });
  for (const c of m.clipped.slice(0, 10)) add({ ...at, check: "text-clip", where: c.sel, detail: `${c.label}: clipped by ${c.by}px`, fix: FIX["text-clip"] });
  for (const q of m.squeezed.slice(0, 10)) add({ ...at, check: "squeezed", where: q.sel, detail: `${q.label}: only ${q.w}px wide`, fix: FIX.squeezed });
  for (const t of m.truncated.slice(0, 10)) add({ ...at, check: "truncated", where: t.sel, detail: `${t.label}: ${t.shown}% visible`, fix: FIX.truncated });
  if (m.colorScheme !== "dark" && m.colorScheme !== "dark light") add({ ...at, check: "color-scheme", where: ":root", detail: `color-scheme is "${m.colorScheme}"`, fix: FIX["color-scheme"] });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })));
  for (const v of axe) add({ ...at, check: "axe", where: v.nodes.join(", "), detail: `${v.id} (${v.impact}): ${v.help}`, fix: `Fix per axe rule ${v.id}.`, guide: "accessibility" });
  return m;
}

async function setState(page, viewport, state) {
  const mobile = viewport.width < 1100;
  const click = async (name, opts = {}) => {
    const b = page.getByRole("button", { name, ...opts }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      await page.waitForTimeout(350);
      return true;
    }
    return false;
  };
  if (state === "network") {
    if (mobile) await click("Toggle network");
  } else if (state === "inspector") {
    await click(mobile ? "Toggle inspector" : "Collapse inspector", {}).catch(() => {});
    if (mobile) await click("Toggle inspector");
  } else if (state === "new-session") {
    await click("New session", { exact: true });
    await page.getByRole("dialog", { name: "New session" }).waitFor({ timeout: 3000 }).catch(() => {});
  } else if (state === "composer-focus") {
    const box = page.getByRole("textbox", { name: "Message your agent" });
    if (await box.isVisible().catch(() => false)) {
      await box.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    }
  } else if (state === "keyboard") {
    // Tab through the page from the top, the way a keyboard user does, and stop on the eighth stop.
    await page.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
  } else if (state === "extend") {
    if (mobile) await click("Toggle inspector");
    await page.getByRole("tab", { name: "Extend" }).click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const summary = [];
for (const viewport of VIEWPORTS.filter((v) => !only.length || only.includes(v.id))) {
  for (const state of STATES) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch && viewport.width < 900,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await page.waitForTimeout(1400);
    await setState(page, viewport, state);
    await page.waitForTimeout(250);
    const file = join(outDir, `${viewport.id}-${state}.png`);
    await page.screenshot({ path: file });
    await measureAndAxe(page, viewport, state);
    if (state === "keyboard") {
      // WCAG 2.4.11 Focus Not Obscured (Minimum): the focused control must not be covered by a fixed bar or another element.
      const hidden = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { none: true };
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const covered = !!top && !el.contains(top) && !top.contains(el);
        const sel = top ? (top.className && typeof top.className === "string" ? top.tagName.toLowerCase() + "." + top.className.trim().split(/\s+/)[0] : top.tagName.toLowerCase()) : "none";
        return { covered, by: sel, label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40) };
      });
      if (hidden.covered) add({ viewport: viewport.id, state, check: "obscured", where: hidden.label, detail: `focused control is covered by ${hidden.by}`, fix: FIX.obscured, guide: "accessibility" });
    }
    summary.push({ viewport: viewport.id, state, screenshot: relative(outDir, file) });
    await context.close();
    console.log(`reviewed ${viewport.id} / ${state}`);
  }
}
await browser.close();

const pxFiles = pxFontSizes();
const pxTotal = pxFiles.reduce((n, f) => n + f.count, 0);
if (pxTotal) findings.push({ viewport: "all", state: "static", check: "px-text", where: pxFiles.map((f) => `${f.file}:${f.count}`).join(", "), detail: `${pxTotal} font-size declarations in px`, fix: FIX["px-text"], guide: "respect-os-text-scale" });
const counts = {};
for (const f of findings) counts[f.check] = (counts[f.check] ?? 0) + 1;
writeFileSync(join(outDir, "findings.json"), JSON.stringify({ url, runId, viewports: VIEWPORTS, states: summary, counts, findings }, null, 2) + "\n");

// Report: grouped by guide, then by check, with the fix for each group and the first occurrences as evidence.
const byGuide = {};
for (const f of findings) (byGuide[f.guide] ??= []).push(f);
const lines = [`# UI review ${runId}`, "", `URL: ${url}`, `OS text scale: ${textScale * 100}%`, "", "| check | count |", "|---|---|"];
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
lines.push("", "## Actionable findings, by guide", "");
for (const [guide, list] of Object.entries(byGuide).sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`### ${guide} (${list.length})`, "", `Retrieve: \`npx modern-web-guidance@latest retrieve "${guide}"\``, "");
  const byCheck = {};
  for (const f of list) (byCheck[f.check] ??= []).push(f);
  for (const [check, items] of Object.entries(byCheck)) {
    const where = [...new Set(items.map((f) => `${f.viewport}`))].join(", ");
    lines.push(`- **${check}** in ${where}: ${items[0].fix}`);
    const uniq = [...new Map(items.map((f) => [`${f.where}|${f.detail}`, f])).values()].slice(0, 8);
    for (const f of uniq) lines.push(`  - \`${f.where}\` (${f.viewport}/${f.state}): ${f.detail}`);
  }
  lines.push("");
}
lines.push("## Screenshots", "", "| viewport | state | file |", "|---|---|---|");
for (const s of summary) lines.push(`| ${s.viewport} | ${s.state} | ${s.screenshot} |`);
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log(JSON.stringify({ outDir, counts }, null, 2));
