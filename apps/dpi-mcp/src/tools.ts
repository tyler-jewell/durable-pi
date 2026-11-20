// Tool definitions and handlers for dpi-mcp. The check → test → push cadence is deduped
// by a per-app fingerprint: each check runs at most once per code state.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { appDir, clip, fingerprint, loadState, saveState, run, ROOT, STATE_DIR } from "./util.js";
import type { PipelineState } from "./util.js";
import { archiveApp, restoreApp } from "./archive.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
import { callDecision } from "./model-tools.js";
import type { ModelTools } from "./model-tools.js";
import { loadStore, select } from "./tool-store.js";
import { scanFiles, selectFiles } from "./scan-files.js";
import { liveClient, pushBaseline } from "./artifacts-git.js";
import { sendBoard } from "./board.js";

// ------------------------------------------------------------------ progress / events

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Save pipeline state with a fresh fingerprint, so generated files written during a run
 * (package-lock.json from npm install, deploy files) don't make the next run re-check. */
const persist = (app: string, next: PipelineState) => saveState(app, { ...next, fingerprint: fingerprint(appDir(app)) });

export interface Event {
  step: string;
  status: "started" | "done" | "error" | "info" | "cached";
  ts: number;
  detail?: string;
  durMs?: number;
}

export class Progress {
  private events: Event[] = [];
  private t0 = new Map<string, number>();
  constructor(
    private server: McpServer,
    private extra: Extra,
    private total: number,
  ) {}

  async emit(step: string, status: Event["status"], detail?: string, done = 0) {
    const e: Event = { step, status, ts: Date.now(), detail };
    if (status === "started") this.t0.set(step, Date.now());
    if ((status === "done" || status === "error") && this.t0.has(step)) {
      e.durMs = Date.now() - (this.t0.get(step) ?? Date.now());
    }
    this.events.push(e);
    const token = this.extra._meta?.progressToken;
    const doneCount = this.events.filter((x) => x.status === "done" || x.status === "error").length;
    if (token !== undefined) {
      try {
        await this.extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: done + doneCount, total: this.total, message: `${step}: ${detail ?? status}` },
        });
      } catch {
        /* progress is best-effort */
      }
    }
    try {
      await this.server.sendLoggingMessage({ level: status === "error" ? "error" : "info", data: `${step}: ${detail ?? status}` }, this.extra.sessionId);
    } catch {
      /* logging is best-effort */
    }
  }

  get log(): Event[] {
    return this.events;
  }
}

// ------------------------------------------------------------------ pipeline steps

/** Install dependencies once (setup, not a check). Cached by node_modules existence. */
async function ensureDeps(app: string, p: Progress) {
  const dir = appDir(app);
  if (existsSync(join(dir, "node_modules"))) return;
  await p.emit("deps", "started", "npm install (first run)");
  const r = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 300_000 });
  if (r.code !== 0) {
    await p.emit("deps", "error", clip(r.stderr || r.stdout, 1500), 0);
    throw new Error(`npm install failed: ${clip(r.stderr || r.stdout, 800)}`);
  }
  await p.emit("deps", "done", `installed (${r.durMs}ms)`, 0);
}

/** Quick check: typecheck via the app's own `typecheck` script (vue-tsc). LSP-first. <5s budget. */
async function doCheck(app: string, state: PipelineState | undefined, fp: string, p: Progress) {
  const dir = appDir(app);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`no app at apps/${app}`);
  await ensureDeps(app, p);
  if (state?.fingerprint === fp && state.check?.ok) {
    await p.emit("check", "cached", "typecheck already passed for this code state", 0);
    return state.check;
  }
  await p.emit("check", "started", "typecheck (vue-tsc)");
  const r = run("npm", ["run", "-s", "typecheck"], { cwd: dir, timeoutMs: 60_000 });
  const ok = r.code === 0;
  await p.emit("check", ok ? "done" : "error", ok ? `exit 0 (${r.durMs}ms)` : clip(r.stdout || r.stderr, 1500), 1);
  return { ok, ts: Date.now(), durMs: r.durMs, detail: clip(r.stdout || r.stderr, 1500) };
}

/** Test: build + a browser smoke (renders, no horizontal overflow at phone/desktop, offline reload). <30s budget. */
async function doTest(app: string, state: PipelineState | undefined, fp: string, p: Progress) {
  if (state?.fingerprint === fp && state.test?.ok) {
    await p.emit("test", "cached", "tests already passed for this code state", 0);
    return state.test;
  }
  await p.emit("test", "started", "build + browser smoke");
  const r = run("npx", ["--yes", "tsx", "scripts/app-smoke.mts", app], { cwd: ROOT, timeoutMs: 120_000 });
  const ok = r.code === 0;
  const last = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  const detail = last.replace(/^SMOKE (PASS|FAIL) /, "") || clip(r.stderr, 1500);
  await p.emit("test", ok ? "done" : "error", detail, 1);
  return { ok, ts: Date.now(), durMs: r.durMs, detail };
}

/** Ensure the app has the Cloudflare deploy files for a Workers static-assets deploy. */
function ensureDeployConfig(app: string): void {
  const dir = appDir(app);
  const cfg = join(dir, "wrangler.jsonc");
  if (!existsSync(cfg)) {
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          name: app,
          main: "worker.mjs",
          compatibility_date: "2026-11-19",
          assets: { directory: "./dist", not_found_handling: "single-page-application" },
        },
        null,
        2,
      ) + "\n",
    );
  }
  if (!existsSync(join(dir, "worker.mjs"))) {
    writeFileSync(join(dir, "worker.mjs"), "export default { async fetch() { return new Response(null, { status: 404 }); } };\n");
  }
}

/** True when the Workers script exists. A 404 means definitively gone; transient statuses
 * (429/5xx/network) retry and then fail open, so a flaky verification never blocks the cache. */
async function workerExists(app: string): Promise<boolean> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !account) return true;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${app}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 200) return true;
      if (r.status === 404) return false;
    } catch {
      /* retry below */
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
  }
  return true;
}

/** Push: build (or reuse the test's fresh build) + deploy to Cloudflare Workers (static assets). Event stream of the build. */
async function doPush(app: string, state: PipelineState | undefined, fp: string, p: Progress, buildFresh: boolean) {
  const dir = appDir(app);
  if (state?.fingerprint === fp && state.push?.ok) {
    if (state.push.url && (await workerExists(app))) {
      await p.emit("push", "cached", `already deployed at ${state.push.url}`, 0);
      return state.push;
    }
    await p.emit("push", "info", "cached deployment is stale (worker gone); re-deploying", 0);
  }
  let buildMs = 0;
  if (!buildFresh) {
    await p.emit("push", "started", "build (vite)");
    const build = run("npm", ["run", "-s", "build"], { cwd: dir, timeoutMs: 90_000 });
    if (build.code !== 0) {
      await p.emit("push", "error", clip(build.stderr || build.stdout, 1500), 0);
      return { ok: false, ts: Date.now(), durMs: build.durMs, detail: clip(build.stderr, 1500) };
    }
    buildMs = build.durMs;
    await p.emit("push", "done", `build ok (${build.durMs}ms)`, 1);
  } else {
    await p.emit("push", "info", "reusing build from test", 1);
  }
  ensureDeployConfig(app);
  await p.emit("push", "started", "wrangler deploy");
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  let dep = run("wrangler", ["deploy"], { cwd: dir, timeoutMs: 180_000, env: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } });
  if (dep.code !== 0) {
    await p.emit("push", "info", "deploy failed; retrying once", 1);
    dep = run("wrangler", ["deploy"], { cwd: dir, timeoutMs: 180_000, env: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } });
  }
  const url = dep.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  const ok = dep.code === 0 && Boolean(url);
  await p.emit("push", ok ? "done" : "error", ok ? url : clip(dep.stderr || dep.stdout, 1500), 1);
  return { ok, ts: Date.now(), durMs: buildMs + dep.durMs, url, detail: clip(dep.stderr || dep.stdout, 1500) };
}

/** Run the full cadence check → test → (push), each step deduped by fingerprint. */
async function runCadence(app: string, includePush: boolean, p: Progress) {
  const dir = appDir(app);
  const fp = fingerprint(dir);
  const state = loadState(app);
  const next: PipelineState = { app, fingerprint: fp, check: state?.check, test: state?.test, push: state?.push };

  const check = await doCheck(app, state, fp, p);
  next.check = { ...check };
  if (!check.ok) {
    persist(app, next);
    return { fp, check, test: undefined, push: undefined, ok: false };
  }
  const test = await doTest(app, state, fp, p);
  next.test = { ...test };
  if (!test.ok) {
    persist(app, next);
    return { fp, check, test, push: undefined, ok: false };
  }
  let push;
  if (includePush) {
    push = await doPush(app, state, fp, p, !(state?.fingerprint === fp && state?.test?.ok));
    next.push = { ...push };
  }
  persist(app, next);
  return { fp, check, test, push, ok: includePush ? Boolean(push?.ok) : true };
}

// ------------------------------------------------------------------ tool registration

export function registerTools(server: McpServer, models: ModelTools): void {
  registerDiscoveryTools(server, models);
  server.registerTool(
    "board_send",
    {
      title: "Send work to the agent board",
      description: "Send a message to the durable agent board. This is how work is requested. Do not open an issue or a pull request.",
      inputSchema: { message: z.string().min(1).max(4000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const sent = await sendBoard(fetch, process.env, args.message);
      return { content: [{ type: "text" as const, text: JSON.stringify(sent) }], structuredContent: sent };
    },
  );
  server.registerTool(
    "artifacts_push",
    {
      title: "Push the current commit to Artifacts",
      description:
        "Push HEAD to the Artifacts baseline, which is the git server. A short-lived write token is minted and never returned. After the push, the public main branch is updated. Do not push the project to any other git host yourself.",
      inputSchema: { mirror: z.boolean().optional().describe("also update the public main branch (default true)") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const pushed = await pushBaseline(liveClient(ROOT), process.env, args.mirror !== false);
      const body = { ...pushed };
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
    },
  );
  server.registerTool(
    "scan_files",
    {
      title: "Categorize tracked files with a decision tool",
      description:
        "Scan Git-tracked files and categorize each one with an enabled mesh decision tool. Untracked and ignored files are skipped. A file that cannot be judged is an error, not an answer. Does not run on commit.",
      inputSchema: {
        question: z.string().min(1),
        outputs: z.array(z.string().min(1)).min(2),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        requires: z.array(z.string()).optional(),
        concurrency: z.number().int().positive().max(8).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const listed = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
      const files = selectFiles(listed, args.include ?? [], args.exclude ?? [], args.limit);
      const store = loadStore();
      const scanned = await scanFiles(files, async (path) => {
        const tool = select(store, "decision", { requires: ["decision", "mesh", ...(args.requires ?? [])] });
        const text = readFileSync(join(ROOT, path), "utf8").slice(0, 4000);
        const judged = await callDecision(store, tool, { path, text }, {
          category: { type: "choice", instructions: args.question, criteria: Object.fromEntries(args.outputs.map((label) => [label, label])) },
        });
        const answer = judged.answers.category;
        if (!answer || answer.type !== "choice") throw new Error("the file was not judged");
        return { answer: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, tool: tool.name };
      }, args.concurrency ?? 2);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(scanned, null, 2) }],
        structuredContent: scanned,
      };
    },
  );
  server.registerTool(
    "create_app",
    {
      title: "Create a web app from the PWA-Vue template",
      description:
        "Create a new single-page web app in apps/<name> from the PWA-Vue template, run the check→test cadence, and optionally deploy it to Cloudflare. Uses the Cloudflare API credentials in the environment. Emits progress for each step and returns the full event log plus the live URL when deployed.",
      inputSchema: {
        name: z.string().min(1).max(40).describe("app name: lowercase letters, digits and hyphens"),
        title: z.string().optional().describe("display title; defaults to the Title Case of the name"),
        deploy: z.boolean().optional().describe("also push the app to Cloudflare and return its live URL"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const total = (args.deploy ? 8 : 6) as number;
      const p = new Progress(server, extra, total);
      const dir = appDir(args.name);
      if (existsSync(dir)) throw new Error(`apps/${args.name} already exists`);
      await p.emit("scaffold", "started", `create apps/${args.name} from templates/pwa-vue`);
      const r = run("npx", ["--yes", "tsx", "scripts/app.mts", "add", "app", args.name, args.title ?? args.name], { cwd: ROOT, timeoutMs: 60_000 });
      if (r.code !== 0) {
        await p.emit("scaffold", "error", clip(r.stderr || r.stdout, 1500), 0);
        return { content: [{ type: "text", text: clip(r.stderr || r.stdout) }], isError: true };
      }
      await p.emit("scaffold", "done", `created apps/${args.name}`, 1);
      const cadence = await runCadence(args.name, Boolean(args.deploy), p);
      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.name, dir: `apps/${args.name}`, ...cadence, events: p.log }, null, 2) }],
        structuredContent: { app: args.name, dir: `apps/${args.name}`, ok: cadence.ok, fingerprint: cadence.fp, url: cadence.push?.url, events: p.log },
      };
    },
  );

  server.registerTool(
    "check",
    {
      title: "Quick check (typecheck, <5s)",
      description: "Run the typecheck for one app (LSP-first: the same diagnostics the language server reports). Cached: does not re-run when the app has not changed since the last passing check.",
      inputSchema: { app: z.string().min(1).max(40).describe("app name under apps/") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = new Progress(server, extra, 1);
      const fp = fingerprint(appDir(args.app));
      const state = loadState(args.app);
      const check = await doCheck(args.app, state, fp, p);
      const next: PipelineState = { app: args.app, fingerprint: fp, check, test: state?.test, push: state?.push };
      persist(args.app, next);
      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.app, ...check, fingerprint: fp, events: p.log }, null, 2) }],
        structuredContent: { app: args.app, ok: check.ok, fingerprint: fp, durMs: check.durMs, cached: p.log.some((e) => e.status === "cached"), detail: check.detail, events: p.log },
      };
    },
  );

  server.registerTool(
    "test",
    {
      title: "Run tests including browser (<30s)",
      description: "Build the app and run a browser smoke test (renders, no horizontal overflow at phone/desktop widths, offline reload). Cached per code state and requires check to have passed.",
      inputSchema: { app: z.string().min(1).max(40).describe("app name under apps/") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = new Progress(server, extra, 2);
      const fp = fingerprint(appDir(args.app));
      const state = loadState(args.app);
      const check = await doCheck(args.app, state, fp, p);
      if (!check.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ app: args.app, ok: false, check, events: p.log }) }], isError: true };
      }
      const test = await doTest(args.app, state, fp, p);
      const next: PipelineState = { app: args.app, fingerprint: fp, check, test, push: state?.push };
      persist(args.app, next);
      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.app, ok: test.ok, check, test, fingerprint: fp, events: p.log }, null, 2) }],
        structuredContent: { app: args.app, ok: test.ok, fingerprint: fp, durMs: test.durMs, detail: test.detail, events: p.log },
      };
    },
  );

  server.registerTool(
    "push",
    {
      title: "Build and deploy to Cloudflare (event stream)",
      description: "Build the app and deploy it to Cloudflare Workers (static assets). Emits the build/deploy progress as an event stream and returns the live URL. Requires check and test to have passed for the current code state (they are cached, never re-run).",
      inputSchema: { app: z.string().min(1).max(40).describe("app name under apps/") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = new Progress(server, extra, 3);
      const fp = fingerprint(appDir(args.app));
      const state = loadState(args.app);
      const check = await doCheck(args.app, state, fp, p);
      if (!check.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ app: args.app, ok: false, check, events: p.log }) }], isError: true };
      }
      const test = await doTest(args.app, state, fp, p);
      if (!test.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ app: args.app, ok: false, test, events: p.log }) }], isError: true };
      }
      const push = await doPush(args.app, state, fp, p, !(state?.fingerprint === fp && state?.test?.ok));
      const next: PipelineState = { app: args.app, fingerprint: fp, check, test, push };
      persist(args.app, next);
      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.app, ok: push.ok, url: push.url, events: p.log }, null, 2) }],
        structuredContent: { app: args.app, ok: push.ok, fingerprint: fp, url: push.url, events: p.log },
      };
    },
  );

  server.registerTool(
    "app_add_route",
    {
      title: "Add a route and page to an app",
      description: "Add a page component and its route to an existing app (edits only the generated regions of src/routes.ts).",
      inputSchema: {
        app: z.string().min(1).max(40),
        path: z.string().min(1).describe("route path, e.g. /settings"),
        name: z.string().min(1).describe("page name, PascalCase, e.g. Settings"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = run("npx", ["--yes", "tsx", "scripts/app.mts", "add", "route", args.app, args.path, args.name], { cwd: ROOT });
      if (r.code !== 0) return { content: [{ type: "text", text: clip(r.stderr || r.stdout) }], isError: true };
      return { content: [{ type: "text", text: r.stdout.trim() }] };
    },
  );

  server.registerTool(
    "app_add_page",
    {
      title: "Add a page component to an app",
      description: "Add a page component (src/pages/<Name>.vue) with no route to an existing app.",
      inputSchema: { app: z.string().min(1).max(40), name: z.string().min(1).describe("PascalCase page name") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = run("npx", ["--yes", "tsx", "scripts/app.mts", "add", "page", args.app, args.name], { cwd: ROOT });
      if (r.code !== 0) return { content: [{ type: "text", text: clip(r.stderr || r.stdout) }], isError: true };
      return { content: [{ type: "text", text: r.stdout.trim() }] };
    },
  );

  server.registerTool(
    "app_verify",
    {
      title: "Full browser verification of an app",
      description: "Run the full Modern Web Guidance verification (install, typecheck, build, PWA, offline, responsive, motion, dark mode, dialog) against the app in a headless browser and return the report path.",
      inputSchema: { app: z.string().min(1).max(40) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = run("npx", ["--yes", "tsx", "scripts/app-verify.mts", args.app], { cwd: ROOT, timeoutMs: 600_000 });
      const last = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
      return { content: [{ type: "text", text: `${last}\n${clip(r.stdout, 3000)}` }], isError: r.code !== 0 };
    },
  );

  server.registerTool(
    "delete_app",
    {
      title: "Delete an app and archive it in Cloudflare R2",
      description:
        "Delete an app completely: archive its source to Cloudflare R2 (30-day retention), delete the Cloudflare Workers deployment, remove apps/<app> and its pipeline state. Nothing is left locally or in Workers. Revive within 30 days with revive_app.",
      inputSchema: { app: z.string().min(1).max(40).describe("app name under apps/") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const p = new Progress(server, extra, 4);
      const dir = appDir(args.app);
      if (!existsSync(join(dir, "package.json"))) throw new Error(`no app at apps/${args.app}`);

      await p.emit("archive", "started", "tar source + upload to R2");
      await archiveApp(args.app);
      await p.emit("archive", "done", "source archived to R2", 1);

      await p.emit("worker", "started", "delete Workers deployment");
      const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
      const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
      const del = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${args.app}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!del.ok && del.status !== 404) {
        await p.emit("worker", "error", `delete worker failed: ${del.status}`, 0);
        throw new Error(`delete worker failed: ${del.status}`);
      }
      await p.emit("worker", "done", "Workers deployment deleted", 1);

      await p.emit("dir", "started", "remove apps/<app> + pipeline state");
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(STATE_DIR, `${args.app}.json`), { force: true });
      await p.emit("dir", "done", "local app and pipeline state removed", 1);

      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.app, deleted: true, archive: `archive/${args.app}.tar.gz`, reviveWith: "revive_app", retentionDays: 30, events: p.log }, null, 2) }],
        structuredContent: { app: args.app, deleted: true, retentionDays: 30, events: p.log },
      };
    },
  );

  server.registerTool(
    "revive_app",
    {
      title: "Revive a deleted app from its R2 archive",
      description:
        "Restore an archived app (from delete_app) within 30 days: extract the source, reinstall, and redeploy it to Cloudflare Workers. Rejects archives older than 30 days.",
      inputSchema: { app: z.string().min(1).max(40).describe("app name to revive") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const p = new Progress(server, extra, 8);
      const dir = appDir(args.app);
      if (existsSync(join(dir, "package.json"))) throw new Error(`apps/${args.app} already exists; revive only targets deleted apps`);

      await p.emit("restore", "started", "download archive from R2 + extract");
      await restoreApp(args.app);
      await p.emit("restore", "done", `restored apps/${args.app}`, 1);

      const cadence = await runCadence(args.app, true, p);
      return {
        content: [{ type: "text", text: JSON.stringify({ app: args.app, revived: true, ok: cadence.ok, url: cadence.push?.url, events: p.log }, null, 2) }],
        structuredContent: { app: args.app, revived: true, ok: cadence.ok, url: cadence.push?.url, events: p.log },
      };
    },
  );
}
