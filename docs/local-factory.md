# The local-only software factory (Studio on the mesh)

The local factory pairs the `.tsf` `create-app` job with chat and decision models running on the
mesh. The model setup below supports local-only validation. The review gate uses MCP; the coding agents’ model
binding is listed under [Remaining work](#remaining-work-ordered).

## Validated resources (19 Nov 2026)

The Studio runs a loopback `llama-server` router behind Cloudflare Tunnel and Access. Its launch agent
serves one model at a time. Live discovery reports a served context of **16,384 tokens** for both the
Studio and MacBook Pro. Prompt tokens, tool schemas, history, and output all share that window. Use
`discover_models` to refresh the served windows before generating an isolated Pi profile.

Every model answers `/health` and `/v1/models`; decision models report
`architecture.output_modalities: ["decisions"]` and expose `/v1/systemone`; chat models
serve `/v1/chat/completions` (with `timings.predicted_per_second`). A local decision tool returns
bounded answers such as this `choice` verdict:

```json
{ "answers": { "verdict": { "type": "choice", "choice": "approve",
  "confidence": 0.862, "probabilities": { "approve": 0.908, "reject": 0.056, "revise": 0.034 } } } }
```

## Architecture

```
Studio (127.0.0.1)
├── dpi-backend      create-app durable job: planner → builder → scout → test → review → document → deploy
│     ├── coding agents ──► ask_model (enabled mesh chat tools, DPI_PROVIDER=mesh)
│     └── review phase ──► ask_model (mesh + decision) ──► decision endpoint
├── dpi-mcp          MCP tools (create_app/check/test/push, model discovery, ask_model)
└── llama-server     8080 (router, one GGUF at a time from ~/local/models/gguf)
```

- **MCP model calls** go through `ask_model`, which picks an enabled model tool by its tags, or
  through a named model tool. The MCP meter records these calls. Pi’s generated profiles connect
  directly to the model endpoints, so their chat turns do not appear in that meter.
- **The review gate** uses `DPI_MCP_URL` and `DPI_MCP_TOKEN` to ask an enabled decision tool.
  It requires both `mesh` and `decision` before selection, so it cannot fall back to a cloud
  decision tool. If MCP returns no valid decision, the gate uses the reviewer subagent’s verdict.
  The reviewer subagent’s chat model is the device’s `DPI_PROVIDER`.

## What is built

1. **Step 3 — `jev-quality`** (`dpi-backend/src/jobs.ts`): the review phase asks the local
   decision tool a bounded `choice` (approve/revise/reject) on `{ plan, facts, review }`.
   `reviewVerdict()` passes an approval and blocks a confident revise or reject. An unavailable
   decision tool or a low-confidence non-approval leaves the reviewer subagent’s verdict in effect.
   `scripts/prove-jev-quality.mts` checks a live approval and block via the same MCP client and
   gate functions. It also checks both results against the opposite reviewer verdict to rule
   out a fallback-only pass.
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
   passing). The run transcript is in git at `2fd8aae:docs/zero-bootstrap-run.md`.
5. **Feedback loop** (`dpi-backend/src/jobs.ts`, job `feedback`): an observation runs
   `triage → work → review → deploy`; the review phase is the same `runReview()` gate `create-app`
   uses. "See something, say something" in AGENTS.md is this job.

## Coding agents on the mesh

With `DPI_PROVIDER=mesh`, every agent turn in the backend is an `ask_model` call on the dpi-mcp server. The
model id is the tag a tool must carry (`chat`), so the server picks among the enabled chat tools (A/B by
default), applies its context budget, and meters the call. Tool calls go both ways in OpenAI form: the server
passes `tools` to the chat endpoint and returns the `tool_calls` the model made. A cut-off answer is flagged
`truncated`, and its tool calls are withheld.

The chat server must parse tool calls. llama-server does this only with `--jinja`; without it, a model writes
its call as text and the agent gets no tool call. Check it with `scripts/prove-mesh-agent.mts`.

Proof (MacBook Pro, local llama-server with `--jinja`, a small Q4 chat model, 4,096-token window):
a real agent turn called `get_weather` with `{"city":"Paris"}`, the tool result went back, and the answer used
it. Two metered local calls, zero cloud cost. `scripts/prove-mesh-agent.mts` runs this against any dpi-mcp
server with `DPI_MCP_URL` and `DPI_MCP_TOKEN`.

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

1. **Serve tool calls from the Studio and MacBook Pro chat servers.** Add `--jinja` to their
   llama-server commands (a router restart), then run `scripts/prove-mesh-agent.mts` through the
   Access route. Until then, factory agents on the mesh cannot call tools.
2. **Run the durable factory on the mesh.** Run `create-app` with `DPI_PROVIDER=mesh` and check its
   metered calls. The roster's `provider`/`model` fields are advisory: the device's `DPI_PROVIDER` decides
   the route.
3. **Expose zero bootstrap in the browser.** Verify discovery, approval and enablement, then
   prove the full local-only factory job from the hub and isolated browser box. Verify the
   installed iOS PWA over the Access-protected HTTPS route.

See `apps/dpi-mcp/README.md` for the tool list and `docs/tsf-factory-design.md` for the
phase graph.
