// Archive and revive apps in Cloudflare R2. delete_app tars the source (excluding build
// dirs), uploads it to R2 with a deletion marker, and R2's 30-day lifecycle rule expires it.
// revive_app restores it within that window.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir, run } from "./util.js";

const BUCKET = process.env.R2_ARCHIVE_BUCKET ?? "durable-pi-app-archive";
const RETENTION_MS = 30 * 24 * 3600 * 1000;

const archiveKey = (app: string) => `archive/${app}.tar.gz`;
const metaKey = (app: string) => `archive/${app}.json`;

function r2Token(): string {
  const t = process.env.R2_ARCHIVE_TOKEN ?? "";
  if (!t) throw new Error("R2_ARCHIVE_TOKEN is not set; archive/revive need it");
  return t;
}

async function r2(method: "GET" | "PUT" | "DELETE", key: string, body?: Buffer): Promise<Response> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects/${key}`, {
    method,
    headers: { Authorization: `Bearer ${r2Token()}`, ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
    body: body as BodyInit | undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`R2 ${method} ${key}: ${r.status} ${text.slice(0, 200)}`);
  }
  return r;
}

/** Tar the app source (excluding node_modules/dist/.wrangler) and upload it plus a deletion marker. */
export async function archiveApp(app: string): Promise<void> {
  const dir = appDir(app);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`no app at apps/${app}`);
  const staged = mkdtempSync(join(tmpdir(), "dpi-arch-"));
  try {
    const tarPath = join(staged, `${app}.tar.gz`);
    const r = run("tar", ["-czf", tarPath, "--exclude=node_modules", "--exclude=dist", "--exclude=.wrangler", "-C", dir, "."], {
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(`tar failed: ${r.stderr.slice(0, 500)}`);
    const meta = Buffer.from(JSON.stringify({ app, deletedAt: new Date().toISOString() }));
    await r2("PUT", archiveKey(app), readFileSync(tarPath));
    await r2("PUT", metaKey(app), meta);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

/** Download the archive, enforce the 30-day window, and extract it into apps/<app>. */
export async function restoreApp(app: string): Promise<void> {
  const meta = JSON.parse(await (await r2("GET", metaKey(app))).text()) as { app?: string; deletedAt?: string };
  if (!meta.deletedAt) throw new Error(`archive for ${app} has no deletion marker`);
  const ageMs = Date.now() - Date.parse(meta.deletedAt);
  if (ageMs > RETENTION_MS) {
    throw new Error(`archive for ${app} expired (deleted ${Math.round(ageMs / 86_400_000)} days ago; retention is 30 days)`);
  }
  const tar = Buffer.from(await (await r2("GET", archiveKey(app))).arrayBuffer());
  const staged = mkdtempSync(join(tmpdir(), "dpi-revive-"));
  try {
    const tarPath = join(staged, `${app}.tar.gz`);
    writeFileSync(tarPath, tar);
    const dest = appDir(app);
    mkdirSync(dest, { recursive: true });
    const r = run("tar", ["-xzf", tarPath, "-C", dest], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`extract failed: ${r.stderr.slice(0, 500)}`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
