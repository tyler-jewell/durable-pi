# pi-object (Phase A spike)

A one-shot [pi](https://github.com/earendil-works/pi) agent in a Durable Object, vendored from
[`cloudflare/computer` → `examples/pi-ai`](https://github.com/cloudflare/computer/tree/main/examples/pi-ai).
Phase A proves the agent loop, tools and Workspace run **without a Cloudflare account**.

```sh
npm install
npm run local       # scripted model, real Workspace + pi-ai tools (no account)
npm run real        # REAL model (anthropic/claude-haiku-5-5), credentials from ~/.pi/agent/auth.json
npm run typecheck   # tsc against generated wrangler types
npm run dev         # wrangler dev (needs Workers AI access)
```

## What is vendored and why

- `src/`, `run-local.mjs`, `local-shim.mjs`, `wrangler.jsonc`: copied from `examples/pi-ai` at commit
  `3636ffb`, with names changed only.
- `vendor/dofs/`: `@cloudflare/dofs` **0.11.3** built from the `cloudflare/computer` source
  (`packages/dofs`, `tsdown`). It is **not published to npm** (`npm view` → 404), but
  `run-local.mjs` needs its `./testing` export (`SQLiteTestStorage`). `@cloudflare/computer@0.11.3`
  from npm does not ship that export.
- `@cloudflare/computer@^0.11.3` and `@earendil-works/pi-ai@1.5.2` come from npm.

## The Durable Object (`src/index.ts`)

`PiAgent` is one Durable Object per agent name. It owns a `Workspace` (SQLite-backed files plus a worker
shell) and runs the agent loop against Anthropic. Routes:

- `POST /` with `{"task": "..."}` runs the loop and returns `{answer, toolCalls, turns}`.
- `GET /file?path=/workspace/x` reads a file from the agent's workspace (404 if missing).
- `?agent=<name>` addresses another agent. The default is `demo`.

`npm run dev` starts it under `wrangler dev` (workerd, the real Durable Object runtime, local storage).
`npm run dev:verify` runs the end-to-end proof: the agent writes and reads a haiku, the dev server restarts,
and the file is unchanged. Verified on the host and in `apple-box`.

Secrets: `.dev.vars` (gitignored) holds `ANTHROPIC_OAUTH_TOKEN`. See `.dev.vars.example`. The Durable Object never
stores the key: it passes it per request through pi-ai's `env` option.

## Model

`run-real.mjs` uses pi's `ModelRuntime`, so it reads the same login `pi` uses (`~/.pi/agent/auth.json`).
The Durable Object uses `deepseek-flash` (DeepSeek topped up). `run-real.mjs` defaults to `anthropic/claude-haiku-5-5`. Override with
`PI_PROVIDER` and `PI_MODEL_ID`. Verified on the host and in the `apple-box` container: 2 tool calls, file on disk.

## Known issues

- DeepSeek rate limit exhausted. Default moved to Haiku 5.5.
- The Durable Object validates on DeepSeek. The Anthropic OAuth token is no longer used by the DO.
- One verify run in apple-box stalled inside a model call (no client timeout). The verify now bounds every request with `--max-time`.
- The DO is not deployed yet. The `dev` path uses local DO storage, and `wrangler deploy` is untested.
- The shell backend (`exec`) is wired but the verification only exercises `write`/`read`.
- `run-real.mjs` uses pi's SDK on the host. A Durable Object must use pi-ai with its own key or the AI Gateway instead.

- `module.register()` in `local-shim.mjs` prints a Node deprecation warning (`registerHooks`
  is the replacement). Harmless for the spike.
- `vendor/dofs` must be rebuilt from source when `@cloudflare/computer` is bumped.
