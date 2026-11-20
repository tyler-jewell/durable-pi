# dpi-mcp

The Durable Pi MCP server: a streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io)
server that gives every agent the same app workflow — **create**, **check**, **test**, **push** —
plus the app-work tools, all authenticated with one bearer token and driven with our Cloudflare
API credentials.

```
pi (any agent) ──HTTP + SSE, Bearer DPI_MCP_TOKEN──► dpi-mcp ──► templates/pwa-vue, vue-tsc, agent-browser, wrangler
```

## Mesh over Cloudflare (no tailscale)

Every mesh host is a **Cloudflare Tunnel hostname behind Cloudflare Access**. Nothing is reachable
on a private IP, and nothing is reached without a service token.

- **`mesh.json`** (gitignored; template `mesh.example.json`) lists the hosts:

  ```json
  { "hosts": [ { "name": "studio", "hostname": "<host>.<your-zone>", "service_token_env": "CF_ACCESS_STUDIO" } ] }
  ```

- **`~/.dpi-mcp/access.env`** (mode 0600, outside the repo) holds one line per host,
  `CF_ACCESS_STUDIO=<client_id>:<client_secret>`. It is loaded automatically; `DPI_MCP_ACCESS`
  overrides the path.
- **Every model call** goes through `meshFetch`, which attaches `CF-Access-Client-Id` and
  `CF-Access-Client-Secret` for mesh hostnames only. Local and cloud URLs are untouched, and a
  token never reaches any other host.

Without a token, Access answers `401`; with one, the host's llama-server answers. Set up one host
with the `cf` CLI (see [docs/local-factory.md](../../docs/local-factory.md#mesh-over-cloudflare-step-1)).

## Run it

```bash
cd apps/dpi-mcp && npm install
DPI_MCP_TOKEN=<32+ chars> \
CLOUDFLARE_API_TOKEN=<workers deploy token> \
CLOUDFLARE_ACCOUNT_ID=09f27fe672991450d128a652b5fb4d73 \
npm start            # http://127.0.0.1:4789/mcp
```

Every MCP request must carry `Authorization: Bearer <DPI_MCP_TOKEN>`. `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` are only needed by `push` (Workers deploy); `check` and `test`
run without them.

## Tools

| Tool | What it does | Budget | Cached? |
|---|---|---|---|
| `create_app` | scaffold an app from `templates/pwa-vue`, then run check → test (→ push when `deploy: true`) | — | steps are |
| `check` | `npm run typecheck` (vue-tsc) — LSP-first | < 5 s | per fingerprint |
| `test` | build + browser smoke (renders, no horizontal overflow at phone/desktop, offline reload) | < 30 s | per fingerprint |
| `push` | build + `wrangler deploy` (Workers static assets); streams the build as events | — | per fingerprint |
| `app_add_route` | add a page + route to an existing app | — | no |
| `app_add_page` | add a page component (no route) | — | no |
| `app_verify` | full Modern Web Guidance browser verification (`scripts/app-verify.mts`) | — | no |
| `delete_app` | archive the source to R2, delete the Workers deployment, remove `apps/<app>` + pipeline state | — | no |
| `revive_app` | restore an archived app (≤30 days) and redeploy it to Cloudflare | — | no |
| `list_models` | read each host's discovered LLMs / decision models | — | yes |
| `list_capabilities` | the settings surface: every capability's state, inputs and options | — | yes |
| `discover_host` | probe a host and record its models | — | yes |
| `inspect_host` | SSH a host: model-server config, launchd auto-start, and a live test | — | yes |
| `recommend_capability` | turn a discovered model into a named capability (recommended) | — | no |
| `enable_capability` | supply inputs/options and turn a capability on | — | yes |
| `disable_capability` | toggle a capability off (kept in settings) | — | yes |
| `run_llm` | chat completion on an enabled LLM capability (auto: local hot-first, cloud fallback) | — | no |
| `run_decision` | System One (Jev/Clef) decision on an enabled decision capability | — | no |
| `list_usage` | local kWh + cost at the configured electricity price | — | yes |
| `discover_cloud` | read the Cloudflare model catalog: every text model, its kind and its catalog price, recorded as recommended (never enabled) | — | yes |
| `compare_costs` | per model: cloud $/min rate vs local electricity + wait-time opportunity | — | yes |
| `update_settings` | edit electricity price/kWh and idle/load watts | — | yes |
| `notify_ready` | append a readiness entry (with validation evidence) to the team feed | — | no |
| `team_feed` | read the feed of capability-readiness announcements | — | yes |

Every tool returns `structuredContent` with a full ordered `events` array
(`{ step, status, ts, detail, durMs }`) so the caller sees the progress of each step, and
`create_app` / `push` stream live MCP progress notifications while they run.

## The cadence (nothing runs twice)

The three CI/CD tools form one pipeline, deduped by a per-app **fingerprint** (hash of the
app's source tree, ignoring `node_modules`/`dist`/`.wrangler`). State lives in
`~/.dpi-mcp/pipelines/<app>.json`.

- `check` re-runs only when the app changed since the last passing check.
- `test` requires `check` to have passed on the current fingerprint, and re-runs only when
  the app changed.
- `push` requires `check` and `test` to have passed, and re-runs only when the app changed.

So for 100% of changes in any app, running `check → test → push` (or just `push`, which runs
the other two first) exercises each check exactly once per code state. Re-running on an
unchanged app returns `cached` in a few milliseconds.

## Wire pi to it

Project config at `.pi/mcp.json` (committed):

```json
{
  "mcpServers": {
    "dpi-mcp": {
      "url": "http://127.0.0.1:4789/mcp",
      "headers": { "Authorization": "Bearer ${DPI_MCP_TOKEN}" },
      "exposure": "direct",
      "description": "Create web apps and run the check/test/push cadence."
    }
  }
}
```

`DPI_MCP_TOKEN` comes from the environment. Start pi in the project (project trust) and the
tools appear as `mcp__dpi_mcp__create_app`, `mcp__dpi_mcp__check`, `mcp__dpi_mcp__test`,
`mcp__dpi_mcp__push`, `mcp__dpi_mcp__app_add_route`, `mcp__dpi_mcp__app_add_page`,
`mcp__dpi_mcp__app_verify`, `mcp__dpi_mcp__delete_app`, `mcp__dpi_mcp__revive_app`,
`mcp__dpi_mcp__list_models`, `mcp__dpi_mcp__list_capabilities`, `mcp__dpi_mcp__discover_host`,
`mcp__dpi_mcp__inspect_host`, `mcp__dpi_mcp__recommend_capability`, `mcp__dpi_mcp__enable_capability`,
`mcp__dpi_mcp__disable_capability`, `mcp__dpi_mcp__run_llm`, and `mcp__dpi_mcp__run_decision`.

For a bare-bones container, run the server where the container can reach it (for an Apple
container that is the host bridge, `192.168.64.1:4789`), set `DPI_MCP_TOKEN` in the
container, and use that URL in the container's `.pi/mcp.json`.

## Notes

- `push` deploys as a **Workers static-assets** site (it writes `wrangler.jsonc` + a trivial
  `worker.mjs` on first push). The deploy token needs Workers Scripts Read+Write; see
  `docs/cloudflare-credentials.md`.
- Progress notifications and the `events` array are the event stream: `create_app` and
  `push` emit a `started`/`done` event per step.
- **Archive**: `delete_app` tars the source and uploads it to the R2 bucket
  `durable-pi-app-archive` (object `archive/<app>.tar.gz` + a `archive/<app>.json` marker),
  then deletes the worker and the local app. R2's `delete-after-30-days` lifecycle rule
  expires the archive; `revive_app` restores + redeploys within that window and rejects
  older archives. Needs `R2_ARCHIVE_TOKEN` (Workers R2 Storage Read+Write) and
  `R2_ARCHIVE_BUCKET` in the server environment.

## Zero bootstrap (one command, zero to tested models)

```bash
npx tsx scripts/zero.mts          # the dialog: every discovered local model pre-checked; Enter submits
npx tsx scripts/zero.mts --yes    # no dialog: take the defaults
```

It discovers every mesh host, lists its local LLMs and decision models, and enables the set you
submit. Each enabled model is tested live with the same probe, so the results compare directly.
Only local models are called. The run ends with **realized cost** (electricity only, with wait
time not counted), priced against a cloud twin only where one exists with a catalog price, and an
**A/B coverage** check (300 draws per required purpose). It sets the default selection mode to
A/B random and exits `0` only when every model passed. A host that refuses its token is listed as
`access denied`. The logic is in `src/zero.ts`, and the offline eval in
`tests/zero-bootstrap.eval.ts` runs the same code against mock servers.

The proof run is in [docs/zero-bootstrap-run.md](../../docs/zero-bootstrap-run.md).

## Capabilities (per-host LLMs and decision models)

A second registry, `~/.dpi-mcp/capabilities.json` (override with `DPI_MCP_CAPABILITIES`),
holds two layers and is driven entirely by MCP tools:

- **`hosts`** — raw discovery: `discover_host` probes a host's `/health` and `/v1/models`
  and records each model as a chat `llm` or a `decision` model (llama.cpp 1.0.0 reports each
  model's `output_modalities`).
- **`capabilities`** — what agents have made usable: a named thing with a
  `recommended → enabled/disabled` state, the `inputs` it needs and the `options` it exposes.

An agent loops the whole lifecycle with tools alone:

```
discover_host (host, address, ssh?)   # probe → hosts[]
inspect_host (host)                   # ssh config + launchd auto-start + a live test
list_models                           # see what was found
recommend_capability (host, model, purpose, inputs?, options?)   # → recommended
enable_capability (id, inputs?, options?, autoEnable?)           # turn it on now, or…
list_capabilities                 # …it stays here in settings for a later toggle
run_llm / run_decision            # use an enabled capability (local default, cloud fallback)
notify_ready (capability, host, model, validated, message)  # tell the team it's ready
team_feed                         # read every readiness announcement, newest last
```

The proof runs the whole loop live with no hardcoded host facts (the host comes from `mesh.json`):

```bash
DPI_MCP_SSH_HOST=studio npx tsx apps/dpi-mcp/scripts/prove-capability-loop.mts
# 1. discover: studio exposes 9 models
# 2. inspect: 4 llama-server process(es), 0 launchd auto-start(s), live test ok (1.4 s)
# 3. recommend: studio-decision-clef-flash-q4-k-m (decision, state=recommended)
# 4. gate: passed (llama-server present + live test ok)
# 5. deploy: studio-decision-clef-flash-q4-k-m enabled (autoEnable=true)
# 6. end-to-end: OpenJev-Q4_K_M → approve (20.2 s)
# 7. notify: team feed now has 1 entry — validated and deployed on studio
```

`notify_ready` writes the validation evidence to `~/.dpi-mcp/team-feed.json`
(`DPI_MCP_TEAM_FEED` to override) — the "tell the team when ready" channel any agent or
settings UI reads with `team_feed`.

Model access is one surface: `run_llm`/`run_decision` call a capability by id (the agent
decides deterministically), or, with no id, resolve **automatically** — the next-best-cheapest:
an enabled local capability, most-recently-used first (so the already-loaded model is reused and
no swap is paid), falling back to cloud. A capability carries a `transport` (`openai-compat` for a
local llama-server/Ollama, `cloudflare-workers-ai` for the Cloudflare Workers AI API), so the
same tool reaches both. Nothing is seeded by hand. The zero bootstrap (`scripts/zero.mts`) discovers and
enables local models, and `discover_cloud` records the Cloudflare catalog as recommended cloud
capabilities with their catalog prices. The registry always reflects the current system.

**Local cost is metered.** Every local `run_llm`/`run_decision` call records its interval;
`list_usage` reports total kWh (idle power over elapsed time plus load power over the **union** of
call intervals, so concurrent/parallel calls share the load and never double-count) and the dollar
cost at the configured price. `update_settings` edits `electricityUsdPerKwh` (global price/kWh,
default 0.15), `idleWatts` and `loadWatts` — these are system settings, not hardcoded.

`enable_capability` reports any missing required inputs and sets `autoEnable` (auto-turn-on:
re-enable after startup/discovery without re-asking, default true); `disable_capability` keeps
the capability (and its inputs/options) for re-enable. Secret input values are masked in every
listing. `resolveCapability(registry, purpose)` is the in-process binding the factory uses — a
`decision` capability with `purpose: ["jev-quality"]` is what the `create-app` reviewer
gate should consume when enabled (see `docs/local-factory.md`).

The **core eval** `tests/zero-agent.eval.ts` proves the loop offline: a zero-code-base agent,
given only a host address + ssh target, identifies the decision models, the server, its config
and launchd auto-start, tests it live, proposes the capability, and — only if the config is
right — gets approved and validated with auto-turn-on set.
