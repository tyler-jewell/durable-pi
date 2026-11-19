// Shared helpers for the dpi-mcp tools: repo layout, command running, fingerprints, and
// the pipeline state that makes the check → test → push cadence run each step once per code state.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const APPS = join(ROOT, "apps");
export const STATE_DIR = join(homedir(), ".dpi-mcp", "pipelines");

export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durMs: number;
}

/** Run a command and capture stdout/stderr and wall time. Never throws; returns exit code. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): RunResult {
  const start = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durMs: Date.now() - start };
}

/** Trim + truncate a blob of output for a tool result. */
export function clip(s: string, max = 6000): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(${t.length - max} chars truncated)…` : t;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".git", ".vite", "coverage"]);
// Generated deploy artifacts written by the push step (ensureDeployConfig). They are not
// app source, so they stay out of the fingerprint — otherwise a deploy would change the
// fingerprint and make the next check/test re-run needlessly.
const SKIP_FILES = new Set(["wrangler.jsonc", "worker.mjs"]);

/** A stable hash of an app's source tree (paths + contents), excluding build output and deps. */
export function fingerprint(appDir: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (SKIP_DIRS.has(f) || SKIP_FILES.has(f)) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        h.update(p.slice(appDir.length + 1));
        h.update("\0");
        h.update(readFileSync(p));
        h.update("\0");
      }
    }
  };
  walk(appDir);
  return h.digest("hex").slice(0, 24);
}

export interface StepRecord {
  ok: boolean;
  ts: number;
  durMs: number;
  url?: string;
  detail?: string;
}

export interface PipelineState {
  app: string;
  fingerprint: string;
  check?: StepRecord;
  test?: StepRecord;
  push?: StepRecord;
}

export function stateFile(app: string): string {
  return join(STATE_DIR, `${app}.json`);
}

export function loadState(app: string): PipelineState | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(app), "utf8")) as PipelineState;
  } catch {
    return undefined;
  }
}

export function saveState(app: string, state: PipelineState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(app), JSON.stringify(state, null, 2) + "\n");
}

export function appDir(name: string): string {
  if (!APP_NAME_RE.test(name)) throw new Error(`app name "${name}" must be lowercase letters, digits and hyphens`);
  return join(APPS, name);
}
