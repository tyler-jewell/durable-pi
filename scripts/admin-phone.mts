// Proves the phone admin route is up: a public HTTPS name, Access in front, and the local agent answering.
// The name is read from the gitignored admin URL file. It is never written into the repo.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const urlFile = process.env.DPI_ADMIN_URL_FILE ?? join(homedir(), ".dpi", "admin.url");
const raw = readFileSync(urlFile, "utf8").trim();
const url = new URL(raw);
if (url.protocol !== "https:") throw new Error("the admin URL must be https");

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (${detail})`);
};

const local = await fetch("http://127.0.0.1:4780/healthz").then((r) => r.status).catch(() => 0);
check("agent is up", local === 200, `HTTP ${local}`);

const hub = await fetch("http://127.0.0.1:4781/").then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => ({ status: 0, text: "" }));
check("hub is up", hub.status === 200 && hub.text.length > 0, `HTTP ${hub.status}`);

const phone = await fetch(url, { redirect: "manual" }).then(async (r) => ({
  status: r.status,
  location: r.headers.get("location") ?? "",
  server: r.headers.get("cf-ray") ? "cloudflare" : "",
  text: (await r.text()).slice(0, 400),
})).catch((error: Error) => ({ status: 0, location: "", server: "", text: error.message }));
const access = phone.status === 302 && phone.location.includes("cloudflareaccess.com");
const app = phone.status === 200 && phone.text.includes("Durable");
check("phone route answers", access || app, access ? "Access login" : `HTTP ${phone.status}`);
check("phone route is protected or the app", access || app, access ? "Access" : phone.server || "app");

if (checks.some((item) => !item.ok)) process.exit(1);
