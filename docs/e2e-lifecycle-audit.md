# E2E lifecycle audit (create → delete → revive → delete)

A full pass of the app lifecycle through the `dpi-mcp` server, run 2026-11-19, with a
record of every skill/tool the run touched and every one it did **not**, and why.

## The run

| Step | Tool | Wall | What happened |
|---|---|---|---|
| 1 | `create_app lifecycle --deploy true` | 20.0 s | scaffold (690 ms) → `npm install` (7.26 s) → typecheck (1.01 s) → build+browser (5.65 s) → `wrangler deploy` (5.27 s) |
| 2 | `delete_app lifecycle` | 1.72 s | archive to R2 (693 ms) → delete worker (303 ms) → remove app + state (720 ms) |
| 3 | `revive_app lifecycle` | 13.5 s | restore from R2 (520 ms) → install (1.46 s) → typecheck (927 ms) → build+browser (5.07 s) → deploy (5.35 s) |
| 4 | `delete_app lifecycle` | 2.0 s | archive → delete worker → remove app + state |

Final state (verified): `apps/lifecycle` gone, pipeline state gone, Workers script `404`,
and the only survivor is the intended R2 archive (`archive/lifecycle.tar.gz` + `.json`
marker, expiring in 30 days).

## Tools the run used

**MCP tools invoked by name:** `create_app`, `delete_app`, `revive_app`. The pipeline
steps `check` → `test` → `push` executed **inside** `create_app`/`revive_app`, not as
standalone calls.

**Processes the MCP server spawned:** `tar` (archive), `npm` (install / `run typecheck` /
`run build`), `vue-tsc` (the typecheck engine), `vite` (build + preview), `agent-browser`
(headless browser smoke), `wrangler` (deploy).

**Cloudflare APIs the server called directly:** Workers `PUT`-deploy via `wrangler` and
`DELETE /workers/scripts/<app>`; R2 object `PUT`/`GET` (archive + marker).

**Orchestration (this run's setup, not the server):** `cf` CLI (create the R2 bucket,
lifecycle rule, and API tokens), `curl`, `sqlite3` (registry read), `security` (Keychain).

## Skills the run used

No `SKILL.md` was *loaded* at runtime — `dpi-mcp` is a plain Node process that runs
commands, not a pi session. Two skills governed the run **by convention** (their rules are
baked into the code rather than loaded):

- **`durable-pi-browser`** — the browser smoke runs headless (`agent-browser`, no VNC, no
  headed browser), exactly as this skill requires.
- **`agent-browser`** — the CLI the smoke test drives is the tool this skill documents.

## Skills we have but did NOT use (and why)

| Skill | Why it sat out |
|---|---|
| `cf-cli` | The server deploys/archives via `wrangler` + direct `fetch`, not the `cf` CLI. `cf` was used only in one-time setup (bucket, tokens). |
| `cloudflare` | No product selection — the workflow is fixed (Workers + R2). |
| `cloudflare-app-bootstrap` | The template app has no bindings/secrets to wire. |
| `cloudflare-one` | Zero Trust / Access untouched (no SSH or access-policy work). |
| `durable-objects` | No Durable Object code — the target is a static Workers site. |
| `agent-sandboxes-exe-dev` | No exe.dev VM; the run hit the local MCP server directly. |
| `playwright-cli` | The browser smoke uses `agent-browser`; Playwright is only for the repo's UI tests. |
| `terraform-style-guide` | No Terraform change (the mesh infra was not touched). |
| `vue-official-docs` | No Vue authoring by a model — all Vue came from `templates/pwa-vue`. |
| `workers-best-practices` | No new Worker source was written (template + generated `wrangler.jsonc`). |
| `workers-development` | No `cf dev`/`wrangler dev` debugging; the smoke used `vite preview`. |

## Tools we have but did NOT use (and why)

| Tool / surface | Why it sat out |
|---|---|
| `cloudflare` MCP (`docs`, `search`, `execute`, `whoami`) | Replaced by `cf` CLI + direct API `fetch`/`curl`. |
| `mesh-health` MCP (`healthcheck`) | The lifecycle has no tailnet/mesh step. |
| `dpi-mcp` `check` / `test` / `push` (standalone) | They ran, but as pipeline steps inside `create_app`/`revive_app`. |
| `dpi-mcp` `app_add_route` / `app_add_page` / `app_verify` | Not part of the create→delete→revive→delete lifecycle. |
| Durable harness (`dpi-backend`, `pi-durable`, hub, `dpi-tui`, `dpi-sdk`) | The run drove the MCP server via its SDK client directly, not through a durable agent/session on a device. |
| LSP extension / `pi/lsp` gate | `check` uses one-shot `vue-tsc`, not the in-process language server. |
| `just` recipes (`net`, `hub`, `tui`, `app`, `lsp`) | The server calls `scripts/app.mts` and raw commands; no `just` recipe was needed this run. |
| `scripts/app-verify.mts` | `app_verify` was not called; the `test` step runs its own lighter browser smoke. |

## Timing notes

- First-run `npm install` (7.26 s) dominates `create_app`; the revive's install is 1.46 s
  (warm npm cache).
- `delete_app` is ~1.7–2.0 s and leaves nothing but the R2 archive, as designed.
- `revive_app` (13.5 s) ≈ `create_app` minus scaffold + a warm install.
