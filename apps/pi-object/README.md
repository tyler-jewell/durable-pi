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

## Deployed

- URL: https://durable-pi-object.flagseeker.workers.dev
- Account: Hello@flagseeker.com (the account Wrangler is logged into). The personal account `09f27…` used for AI Gateway is not used here.
- Secrets: `DEEPSEEK_API_KEY`, `DPI_TOKEN` (set with `wrangler secret put`). The device token is in `~/.dpi/pi-object.token` (mode 600).
- Every route needs `Authorization: Bearer <token>`. Checked live: no token and wrong token both get 401.
- Live run: 2 tool calls, 4.7s. The file is readable from a separate request. Missing files get 404.

```sh
URL=https://durable-pi-object.flagseeker.workers.dev; TOKEN=$(cat ~/.dpi/pi-object.token)
curl -X POST $URL/ -H "authorization: Bearer $TOKEN" -H content-type:application/json -d '{"task":"..."}'
curl -H "authorization: Bearer $TOKEN" "$URL/file?path=/workspace/haiku.txt"
```

## Scope of the deployed build

- **File tools only** (read, write, edit, ls, find, grep, delete). No `exec`. The worker-shell backend needs the `experimental` compatibility flag, and Cloudflare rejects that flag on deployed Workers (error 10021). Local and deployed builds are the same code.

## Known issues

- DeepSeek rate limit exhausted. Default moved to Haiku 5.5.
- The Durable Object validates on DeepSeek. The Anthropic OAuth token is no longer used by the DO.
- One verify run in apple-box stalled inside a model call (no client timeout). The verify now bounds every request with `--max-time`.
- The deployed Durable Object is on the flagseeker account, not the personal account. Move it if you want one account.
- The public URL can spend the DeepSeek balance. Only the device token protects it. Rotate with `wrangler secret put DPI_TOKEN`.
- No `exec` tool when deployed (see Scope). Its backend needs the `experimental` flag.
- `run-real.mjs` uses pi's SDK on the host. A Durable Object must use pi-ai with its own key or the AI Gateway instead.

- `module.register()` in `local-shim.mjs` prints a Node deprecation warning (`registerHooks`
  is the replacement). Harmless for the spike.
- `vendor/dofs` must be rebuilt from source when `@cloudflare/computer` is bumped.
