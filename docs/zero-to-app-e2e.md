# Zero-to-app e2e: attach a durable-pi agent to an empty project and ship an app

Proves the durable-pi network end to end: from an empty directory on an isolated
Apple-container device, a human using **only the browser** (the hub) attaches a
durable agent, gives it one minimal sentence, and the agent builds and deploys a
single-page web app to Cloudflare on its own. Run 2026-11-19.

**Result:** the agent chose to build **FocusFlow** (a Pomodoro timer) and shipped it to
`https://focusflow.tyler-jewell.workers.dev` in ~7 minutes, 22 tool calls, $0.035 of
model usage. Nothing was scaffolded or written by a human.

## 0. Infra already assumed (not part of "zero")

One device and the hub are the only durable-pi infra needed:

- `apple-box` — an Apple container device (`dpi-network.yaml`, kind `apple-container`,
  `node:26-bookworm-slim`), model provider `cloudflare-ai-gateway` (gateway `durable-pi`).
- `hub` — `apps/dpi-playground`, the web UI on `http://localhost:4781`.

```bash
just net up apple-box     # device online (idempotent)
just hub build            # build the web UI once
just hub start            # serve http://localhost:4781
```

## 1. Attach the agent to a new, empty project

The new project is an empty directory on the device. New sessions may use any
existing folder as `cwd` (the directory browser resolves it, and typing a path
works too).

```bash
container exec apple-box mkdir -p /root/dpi-work/fresh-app-1795117819
```

Then, in the browser (all clicks, no terminal):

1. Open `http://localhost:4781`.
2. **New session** → device `apple-box` → name `fresh-app`.
3. Working directory: `/root/dpi-work/fresh-app-1795117819` (type it or click it in the
   directory browser under Start dirs).
4. Model: the device default, `DeepSeek V4 Flash` (cloudflare-ai-gateway). **Create session**.

The session appears as `apple-box › fresh-app › Main`. The agent's cwd is the empty
project; its tools are the coding tools (`read`, `write`, `edit`, `bash`) plus the
playground tools.

## 2. One minimal prompt, from the browser

In the composer, a single sentence (no app requirements, no tech stack, no deploy
instructions beyond the goal):

> Build a simple single-page web app in this directory. You decide what it does
> and how to build it. Deploy it to Cloudflare and reply with the live URL.

Send it. The agent then worked autonomously: explored the empty directory, found
`wrangler`, confirmed Cloudflare auth, chose its own app idea, wrote the code,
deployed, verified, hit two bugs (SPA fallback 404 and static-asset exclusions),
fixed them locally, redeployed, and verified every route returns 200.

## 3. What the agent built and how

| File | What |
|---|---|
| `public/index.html` (462 lines) | the whole FocusFlow SPA: timer ring, focus/short/long-break modes, task list, pomodoro credits, localStorage persistence, Web Audio chime, responsive glassmorphism UI |
| `src/index.js` (12 lines) | a tiny Worker that serves `public/` as static assets and adds clean SPA fallback |
| `wrangler.jsonc` (9 lines) | `wrangler` config: static `assets`, SPA `not_found_handling`, worker bindings |

Deploy: `wrangler deploy` → `https://focusflow.tyler-jewell.workers.dev`
(a Cloudflare Worker with static assets — the agent noticed the API token lacked
Pages permission and switched to Workers on its own).

Verification the agent ran itself: `/`, `/index.html`, `/tasks` all 200, title
`FocusFlow — Pomodoro Timer`.

## 4. Cost and usage (the whole agent run)

Model: `@cf/deepseek-ai/deepseek-v4-flash-0731` (DeepSeek V4 Flash) via
`cloudflare-ai-gateway` (gateway `durable-pi`). Reported by the device, cumulative:

| Metric | Value |
|---|---|
| Input tokens | 21,615 |
| Output tokens | 16,544 |
| Cache-read tokens | 272,640 |
| **Total tokens** | **310,799** |
| **Total cost** | **$0.0352** (input $0.0095 + output $0.0218 + cache-read $0.0038) |

Tool calls (the agent's actual calls, not the offered set): **bash × 19, write × 3**.
No skills or MCP tools were invoked by the agent — it used only the durable harness's
coding tools.

Cloudflare resources are within the free tier (one Workers script; Workers AI via the
gateway); the Apple container is local, so no VM cost.

## 5. Operator steps that had to happen first (see issues #23, #24)

Two gaps surfaced, both non-blocking and both filed for triage:

- **#23** — the device has no Cloudflare deploy toolchain out of the box. The operator
  installed `wrangler` in the container and injected a scoped deploy token
  (`CLOUDFLARE_API_TOKEN`, Workers Scripts Read+Write + Workers Routes Write) into
  `dpi-network.yaml` before the run.
- **#24** — `wrangler delete` with that scoped token errors on a KV-namespace check
  (`Authentication error [code: 10000]`) even though the worker is actually deleted,
  which the agent read as "cleanup failed".

The deploy token (`durable-pi-e2e-deploy`) is temporary (24 h) and self-expires.
