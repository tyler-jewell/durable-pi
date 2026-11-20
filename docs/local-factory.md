# The local-only software factory (Studio on the mesh)

The `.tsf` factory (`create-app` durable job) run **entirely on the Studio**, using the
Studio's own local LLMs for the coding agents and its local Jev/Clef decision models for the
`jev-quality` reviewer gate — no cloud model calls. This doc records what was validated, what
is built, and what remains.

## Validated resources (19 Nov 2026)

`studio.jewell-labs.com` (Apple M1 Max, 32 GB, reached over a Cloudflare Tunnel + Access) runs **llama.cpp `llama-server` 1.0.0**.
The canonical model root is `~/local/models/` (manifest.json is the SSoT; see
the model lineup is discovered, not listed in the repo), and one router on `:8080` serves one GGUF at a time from
`gguf/` (`--models-max 1`, autoload, sleep-idle 600 s):

| Endpoint | What it is | Models (canonical `gguf/`) | Modality |
|---|---|---|---|
| `127.0.0.1:8080` | multi-model **router** | Clef-Flash, OpenJev, gpt-oss-20b (+ clairic-flash + the 7 text models as they land) | text + decisions |

Every model answers `/health` and `/v1/models`; decision models report
`architecture.output_modalities: ["decisions"]` and expose `/v1/systemone`; chat models
serve `/v1/chat/completions` (with `timings.predicted_per_second`). A real call to
Clef-Flash answered a `choice` question in **~0.75 s** cold:

```json
{ "answers": { "verdict": { "type": "choice", "choice": "approve",
  "confidence": 0.862, "probabilities": { "approve": 0.908, "reject": 0.056, "revise": 0.034 } } } }
```

Benchmarks so far (19 Nov): Clef-Flash 617 ms/decision, OpenJev 1254 ms/decision,
gpt-oss-20b ~40 tok/s generation. The remaining text models land in this batch (below).

## Architecture

```
Studio (127.0.0.1)
├── dpi-backend      create-app durable job: planner → builder → scout → test → review → document → deploy
│     ├── coding agents ──► local LLM (OpenAI /v1)            ← the missing text model
│     └── review phase ──► askJev ──► /v1/systemone (Clef)     ← already works, no code change
├── dpi-mcp          MCP tools (create_app/check/test/push, model discovery, ask_model)
└── llama-server     8080 (router, one GGUF at a time from ~/local/models/gguf)
```

- **Every model call** (coding agents, the review gate, the feedback loop) goes through an MCP tool:
  `ask_model` picks an enabled model tool by its tags, or a caller names one. The backend has no
  local-vs-cloud provider and no model IDs (AGENTS.md). Local hosts are reached over Cloudflare
  Tunnel + Access (below).
- **The review gate's decision model** is an enabled decision tool. The backend still reads
  `JEV_BASE_URL` until the binding in "Remaining work" step 2 lands. The gate fails open to the model reviewer when Jev is
  unreachable, so a sleeping model server never blocks a run.

## What is built

1. **Step 3 — `jev-quality`** (`dpi-backend/src/jobs.ts`): the review phase asks the local
   Jev a bounded `choice` (approve/revise/reject) on `{ plan, facts, review }`; `approve`
   passes, anything else fails the run, and an unreachable Jev fails open to the model
   reviewer. `reviewVerdict()` is exported + unit-tested (`tsf.test.ts`, 25 backend tests).
2. **Model tools** (`dpi-mcp/src/models.ts`, `tool-store.ts`, `model-tools.ts`,
   `discovery-tools.ts`, `host-inspect.ts`): agents drive discovery and enablement with MCP tools
   alone — `discover_models` (mesh and cloud) → `inspect_host` (ssh: config + launchd auto-start +
   a live test) → `list_tools` → `enable_tool` → `ask_model`. The store is `~/.dpi-mcp/tools.json`
   (`DPI_MCP_TOOLS` override). Each enabled model is served as its own tool. The core eval
   `tests/zero-agent.eval.ts` proves the discovery loop offline: a zero-code-base agent, given only
   a host address and an ssh target, identifies the decision models, the server, its configuration
   and launchd auto-start, tests it live, and — only if the configuration is right — enables it.
3. **Mesh over Cloudflare, step 1** (`dpi-mcp/src/mesh-config.ts`, `models.ts`
   `meshFetch`): the Studio's llama-server is reached at its Cloudflare Tunnel hostname behind a
   Cloudflare Access service-token policy. Discovery and every model call attach the token for
   mesh hostnames only. Verified: no token → `401`; token → the Studio's 9 models, a real local
   decision verdict and a real LLM answer. No tailscale anywhere.
4. **Zero bootstrap** (`dpi-mcp/src/zero.ts`, `scripts/zero.mts`): discovers every mesh host
   over Cloudflare Access, lets you choose the models to enable (all pre-checked), tests each
   one live, reports realized electricity cost against cloud, proves A/B coverage, and sets the
   default to A/B random. Proven over two hosts (10 models, the MacBook Pro included, all
   passing). See [zero-bootstrap-run.md](zero-bootstrap-run.md).
5. **Feedback loop** (`dpi-backend/src/jobs.ts`, job `feedback`): an observation runs
   `triage → work → review → deploy`; the review phase is the same `runReview()` gate `create-app`
   uses. "See something, say something" in AGENTS.md is this job.

## Mesh over Cloudflare (step 1)

Each host is one Cloudflare Tunnel connector and one Access-protected hostname. This is the
runbook; every value below is a placeholder (`<host>`, `<zone>`, `<tunnel-id>`, `<app-id>`).
Secrets are written to `~/.dpi-mcp/access.env` (mode 0600), never to the repo or a command line.

1. **Tunnel ingress** (on the host's existing tunnel, which runs `cloudflared` on the host):
   `cf tunnels config update <tunnel-id> --tunnel-config-ingress '[{"hostname":"<host>-llm.<zone>","service":"http://localhost:8080"},{"service":"http_status:404"}]'`
   (keep the host's existing SSH ingress in the same list.)
2. **DNS**: a proxied CNAME `<host>-llm.<zone>` → `<tunnel-id>.cfargotunnel.com`
   (`cf dns records create --zone <zone> --body '{...}'`).
   **Use a one-level name** (`<host>-llm.<zone>`). Universal SSL covers `*.<zone>` only, so a
   two-level name like `llm.<host>.<zone>` fails the TLS handshake.
3. **Access**: a reusable policy with `decision: non_identity` and
   `include: [{"any_valid_service_token": {}}]`, then a self-hosted app on the hostname with that
   policy (`cf zero-trust access policies create`, `cf zero-trust access applications create`).
   `service_auth_401_redirect: true` makes a missing token a plain `401`.
4. **Service token**: `cf zero-trust access service-tokens create --name <name> --duration 8760h`.
   Write `CF_ACCESS_<HOST>=<client_id>:<client_secret>` to `~/.dpi-mcp/access.env` (0600).
5. **Mesh file**: add the host to `apps/dpi-mcp/mesh.json` (copy `mesh.example.json`).
6. **Verify**: `curl` without headers → `401`; with the two `CF-Access-*` headers → `{"status":"ok"}`.
   Then `npx tsx` `discoverMeshModels()` lists the host's models.

### Adding a second host: the MacBook Pro

The same runbook, with one host-side difference: the model server is a launch agent, so it
survives reboots, as the Studio's does.

1. `brew install llama.cpp` (llama-server 1.0.0, the same build as the Studio).
2. Download one GGUF into `~/local/models/gguf/` (the proof run used the granite-4.0-h-micro Q4_K_M
   from the model lineup, about 2 GB, which fits 8 GB of RAM).
3. Write a launch agent at `~/Library/LaunchAgents/<label>.plist` with `ProgramArguments`:
   `llama-server --host 127.0.0.1 --port 8080 -m <gguf> -c 4096 --alias <name>`, `RunAtLoad`
   and `KeepAlive` true. Load it with `launchctl bootstrap gui/$(id -u) <plist>`.
4. Reuse the host's existing tunnel: add an ingress rule for a new one-level hostname pointing at
   `http://localhost:8080`. Add a proxied CNAME for it, then an Access app with the shared
   service-token policy.
5. Create a new service token for this host, so you can revoke it on its own. Append it to
   `~/.dpi-mcp/access.env` as `CF_ACCESS_<HOST>=<id>:<secret>`.
6. Add the host to `mesh.json`, then run `scripts/zero.mts`.

Access apps and tokens are created with the `cf` CLI's account login. The API token in
`dpi-network.yaml` is scoped for tunnels and DNS, not Access, so Access calls fail with
`auth.forbidden` if you try them with it.

## Auto-discover / auto-implement

The tool store is **data derived from each host's own API**, not hand-written config:

- `probeHost` reads `/health` and `/v1/models`. llama.cpp reports each model's `output_modalities`, so
  `text` becomes a chat tool and `decisions` becomes a decision tool. Each model's served window comes
  from the server's own arguments, and never from its trained length.
- Discovery adds every model as a **disabled** tool. `enable_tool` serves it, and `ask_model` selects
  among the enabled tools by the tags a caller requires.
- A new host kind adds one probe and one tool kind. Browsers, speech, or image models use the same
  `discover → enable → ask` loop.

## Remaining work (ordered)

1. **PWA on iOS.** Serve the hub UI (`apps/dpi-playground`) from the Studio over HTTPS
   (the Cloudflare Tunnel gives that), and add a web app manifest + service worker + Apple touch
   icon so "Add to Home Screen" installs it as a standalone app. The hub already serves the
   Vue frontend; the manifest, worker, and icons are the new parts, plus iOS Safari specifics
   (`apple-mobile-web-app-capable`, full-screen `display: standalone`, no service-worker
   assumptions on iOS).
2. **Bind the factory to enabled tools.** Have the review phase call `ask_model` for the decision
   kind (local tools first, by the `decision` tag) instead of `JEV_BASE_URL`, and the coding agents
   call an enabled chat tool. This is the last "auto-implement" stitch.

See `apps/dpi-mcp/README.md` for the tool list and `docs/tsf-factory-design.md` for the
phase graph.
