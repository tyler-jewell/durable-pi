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
CLOUDFLARE_ACCOUNT_ID=<account-id> \
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
| `discover_models` | probe the mesh hosts and/or read the cloud catalog; each model is recorded as a disabled tool | — | yes |
| `list_tools` | every model tool: enabled or not, kind, tags, served window, price (never a secret) | — | yes |
| `probe_tool_use` | ask chat tools to call a fixed test tool, with the agents' `tool_choice`; a structured call with the value adds the `tool-use` tag, anything else removes it | — | no |
| `enable_tool` | serve a model tool: it appears in the server's tool list at once | — | no |
| `disable_tool` | remove a model tool from the list; its record and tags are kept | — | no |
| `ask_model` | pick an enabled tool by required tags (A/B random); `mesh` and `cloud` in `requires` match the tool’s actual source. Chat calls take `tools` (function schemas) and `tool_choice`, accept `tool` messages with `tool_call_id`, and return `toolCalls`; a truncated answer returns none | — | no |
| `set_selection_mode` | how `ask_model` picks: `ab` (random, the default) or `auto` (most recently used, cloud as fallback) | — | yes |
| `inspect_host` | SSH a host: server processes and their served window, launchd auto-start, and a live test | — | yes |
| `list_usage` | local kWh + cost at the configured electricity price | — | yes |
| `compare_costs` | per model: cloud $/min rate vs local electricity + wait-time opportunity | — | yes |
| `update_settings` | edit electricity price/kWh and idle/load watts | — | yes |
| `notify_ready` | append a readiness entry (with validation evidence) to the team feed | — | no |
| `team_feed` | read the feed of readiness announcements | — | yes |

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
`mcp__dpi_mcp__discover_models`, `mcp__dpi_mcp__list_tools`, `mcp__dpi_mcp__enable_tool`,
`mcp__dpi_mcp__disable_tool`, `mcp__dpi_mcp__ask_model`, `mcp__dpi_mcp__inspect_host`, and one
`mcp__dpi_mcp__model_<host>_<model>` for each enabled model.

These are Pi tool identifiers, not shell commands. Standalone programs connect to `/mcp`
with an MCP client (the package uses `Client` and `StreamableHTTPClientTransport` from
`@modelcontextprotocol/sdk`). Discover schemas with `listTools()` and call tools with
`callTool()`. For decisions, pass `state` and `questions` and read `structuredContent.answers`;
check `isError` before using the result.

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

## Model tools

Every model this system knows about is one record in the tool store (`~/.dpi-mcp/tools.json`, override with
`DPI_MCP_TOOLS`), local or cloud. A record that is **enabled** is served on this server as an MCP tool of
its own name, `model_<host>_<model>`, and a disabled one is not in the list. Enabling and disabling change the
list at once, with no restart.

The loop an agent runs, with tools alone:

```
discover_models (scope: mesh | cloud | all)   # every model found, added disabled
list_tools (enabled?, kind?)                  # what exists and what is on
enable_tool (name)                            # serve it now
ask_model (kind, requires?, name?, messages | state + questions)   # call one of the enabled tools
notify_ready (tool, validated, message)       # tell the team it is ready
team_feed                                     # read every readiness announcement, newest last
```

`ask_model` is the one router. It filters the enabled tools of the kind by the tags the caller requires (every
tag must match), then picks one **at random** (A/B), the default. `set_selection_mode auto` picks the most
recently used mesh tool instead, with cloud as the fallback. Passing `name` calls that tool deterministically.
A tool's tags are `chat` or `decision` (from the model's kind), plus any tags a caller adds.

Each call goes through the same path, whichever tool serves it. The **context budget** is checked first: the
window the server runs with (llama-server `--ctx-size`, or the cloud catalog's `context_window`) is shared by
the prompt and the output, so the output cap is clamped to what is left, and a prompt with no room is refused
before anything is sent. A model whose served window is unknown is called unguarded, and the result says so.
A cut-off answer is flagged `truncated` in its text and its structure. Every call is **metered**: local calls
record their interval for kWh, and cloud calls are billed from the catalog price times the tokens.

Discovery never reads a model's trained length as its window: `context_length` is the trained length, and the
served window is the `--ctx-size` the server was started with.

`discover_models scope=cloud` reads the Cloudflare Workers AI catalog. A cloud model's kind comes from the
catalog's own description (a decision model says so), and its price is stored on its record. Nothing in this
repo names a model. `update_settings` edits `electricityUsdPerKwh` (default 0.15), `idleWatts` and `loadWatts`.

**Pi's profile is generated from the store.** `scripts/pi-profile.mts <dir>` writes pi's `models.json` with
each enabled local chat model's served window, and `env.sh` exports the Access header variables from the token
file, with no values written. A model with an unknown window is skipped and listed, never guessed.

The **zero bootstrap** (`scripts/zero.mts`) is the one command that gets a system here: discover, choose,
enable, test every chosen model live, report realized cost, and prove the A/B coverage. See the section above.

The **core eval** `tests/zero-agent.eval.ts` proves the discovery loop offline: a zero-code-base agent, given only
a host address and an ssh target, identifies the decision models, the server, its configuration and launchd
auto-start, tests it live, records the model as a disabled tool, and, only if the configuration is right,
enables it and sees `ask_model` select it.

## Roles

dpi-mcp has two bearer roles, each with its own token:

- **agent** (`DPI_MCP_TOKEN`): every model, discovery and app tool. Agent sessions never see the admin tools in their tool list, and cannot call them.
- **admin** (`DPI_MCP_ADMIN_TOKEN`, at least 16 characters, different from the agent token): the agent tools plus the admin tools. A session keeps the role it started with, and a request under another role is refused with 403.

The admin token is the only credential that can reach the Cloudflare account. It is read from the server's environment (`CLOUDFLARE_ADMIN_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`), and never sent to an agent.

### Admin tools

| Tool | What it does | Destructive | Confirmation |
|---|---|---|---|
| `cloudflare_snapshot` | One view of the account: Workers, Durable Objects, R2, KV, D1, Queues, tunnels, Access applications and service tokens, and the DNS records of one zone (`zone` argument, or `DPI_PRIMARY_ZONE`). Also the billing subscription, the Durable Objects rate card, and the last hour's measured requests priced at list price. Each part that cannot be read says why. | no | none (read only) |

The last hour is a measurement priced by the account's own rate card, before included allowances. It is not an invoice line. The hour is `complete` only when every product in it was measured and priced; Workers requests have no verified rate-card component yet, so any Workers traffic makes the hour incomplete rather than free.
