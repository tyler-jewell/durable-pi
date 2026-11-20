# The local-only software factory (Studio on the mesh)

The local factory pairs the `.tsf` `create-app` job with chat and decision models served by hosts on the mesh. The
review gate and the coding agents both call those models through the dpi-mcp server. The factory has not yet run
end to end on the mesh; see [Remaining work](#remaining-work-ordered).

## Validated resources (19 Nov 2026)

Each host runs a loopback llama.cpp router behind a Cloudflare Tunnel and Access (see
[Local model servers](#local-model-servers-llamacpp)). Live discovery reports a served context of **16,384 tokens**
on both hosts. Prompt tokens, tool schemas, history, and output share that window. `discover_models` refreshes the
served windows.

Every model answers `/health` and `/v1/models`. Decision models report `architecture.output_modalities: ["decisions"]`
and expose `/v1/systemone`. Chat models serve `/v1/chat/completions`. A decision tool returns bounded answers such as
this `choice` verdict:

```json
{ "answers": { "verdict": { "type": "choice", "choice": "approve",
  "confidence": 0.862, "probabilities": { "approve": 0.908, "reject": 0.056, "revise": 0.034 } } } }
```

## Architecture

```
Studio (127.0.0.1)
├── dpi-backend      create-app durable job: planner → builder → scout → test → review → document → deploy
│     ├── coding agents ──► ask_model (enabled mesh chat tools, DPI_PROVIDER=mesh)
│     └── review phase ──► ask_model (mesh + decision tools)
├── dpi-mcp          MCP tools (create_app/check/test/push, model discovery, ask_model)
└── llama-server     8080 (router over one models directory, at most one model resident)
```

- **MCP model calls** go through `ask_model`, which picks an enabled model tool by the tags it requires, or calls a
  named tool. The MCP meter records these calls. Pi's generated profiles connect directly to model endpoints, so
  their turns do not appear in that meter.
- **The review gate** asks an enabled decision tool through `DPI_MCP_URL` and `DPI_MCP_TOKEN`. The request requires the
  `mesh` and `decision` tags, so no cloud decision tool can be selected. If MCP returns no valid decision, the reviewer
  subagent's verdict stands.

## What is built

1. **Review gate** (`apps/dpi-backend/src/jobs.ts`, `jev.ts`): the review phase asks a decision tool a bounded `choice`
   (approve, revise, reject) on `{ plan, facts, review }`. `reviewVerdict()` passes an approval and blocks a confident
   revise or reject. A low-confidence non-approval, or no decision, leaves the reviewer subagent's verdict in effect.
   `scripts/prove-jev-quality.mts` checks a live approval and block through the same client and gate functions, and
   checks each result against the opposite reviewer verdict to rule out a fallback-only pass.
2. **Model tools** (`apps/dpi-mcp/src/models.ts`, `tool-store.ts`, `model-tools.ts`, `discovery-tools.ts`,
   `host-inspect.ts`): agents discover, enable, and call models with MCP tools alone: `discover_models` →
   `inspect_host` → `list_tools` → `enable_tool` → `ask_model`. The store is `~/.dpi-mcp/tools.json` (set `DPI_MCP_TOOLS` to
   move it). `apps/dpi-mcp/tests/zero-agent.eval.ts` runs the discovery loop against a
   mock host.
3. **Mesh over Cloudflare** (`apps/dpi-mcp/src/mesh-config.ts`, `models.ts` `meshFetch`): each host's model server is
   reached at its Access-protected Tunnel hostname. Discovery and every model call attach the service token for mesh
   hostnames only. Without a token the server answers `401`.
4. **Zero bootstrap** (`apps/dpi-mcp/src/zero.ts`, `apps/dpi-mcp/scripts/zero.mts`): discovers every mesh host, lets you
   choose the models to enable (all pre-checked), tests each one live, reports realized electricity cost against a
   priced cloud equivalent, and sets A/B random selection. The run transcript is in git at `2fd8aae`
   ([zero-bootstrap-run.md](zero-bootstrap-run.md)).
5. **Feedback loop** (`apps/dpi-backend/src/jobs.ts`, job `feedback`): an observation runs
   `triage → work → review → deploy`. Its review is the same gate `create-app` uses.

## Coding agents on the mesh

With `DPI_PROVIDER=mesh`, every agent turn in the backend is an `ask_model` call on the dpi-mcp server. The model id is
the tag a tool must carry (`chat`), so the server picks among the enabled chat tools (A/B by default), applies its
context budget, and meters the call. Tool calls go both ways in OpenAI form: the server passes `tools` to the chat
endpoint and returns the `tool_calls` the model made. An answer cut off at the output limit is flagged `truncated`, and
its tool calls are withheld.

Tool calls depend on the model, not only the server. llama-server parses a model's tool calls with its chat template
(Jinja is on by default in this build, and the config pins it). Some models still return their call as plain text. One
served model did that on the Studio while another returned structured calls from the same server. Until each model
passes a tool-use probe, the tool store cannot tell which models are safe for agents (issue #26).

Proof: `apps/dpi-backend/scripts/prove-mesh-agent.mts` runs one agent turn that calls a tool through `ask_model`, returns
the result, and checks the answer. Against a local router it called `get_weather` with `{"city":"Paris"}`, used the
result, and recorded two metered local calls at zero cloud cost. It needs `DPI_MCP_URL` and `DPI_MCP_TOKEN`.

## Local model servers (llama.cpp)

Every host's server is defined once in `llama/config.yaml`. The file names no model: the server runs in router mode over
a models directory, so it serves every GGUF in that directory with at most one resident at a time, and unloads after ten
idle minutes. Flags are listed there, with a comment on each. Per-host values live in `llama/hosts.yaml`, which is not
committed (copy `llama/hosts.example.yaml`): the binary, the models directory, the hostname that `apply` checks, and the
launch agents a host's apply replaces.

```
just llama check                        # the config is valid, and every flag exists in this machine's llama-server
just llama argv <host>                  # the command line a host runs
just llama render <host>                # its launch agent (plist), printed
just llama drift <host> <url>           # the flags a running server reports, against the config
just llama apply <host>                 # on the host itself: write the launch agent, unload what it replaces, start it
just llama test                         # unit tests for the config, the command line, the plist and drift
```

`apply` keeps any plist it overwrites, and any launch agent it replaces, beside the original as `<name>.plist.replaced`.
Restore the file and bootstrap it again to roll back.

Status, checked with `drift` (see issue #26 for what remains):

- **MacBook Pro**: applied. The running server matches the config, and tool calls return structured results.
- **Studio**: not yet applied. Its running router differs in two ways: the slot-introspection endpoint is enabled
  (the config disables it), and Jinja is implicit rather than pinned. Applying the config on that machine closes both.

Open decisions:

- `cache-ram` is 0 on the Studio, which disables the prompt cache. The llama default is 8192 MiB. Measure agent-turn
  latency with and without it before choosing.
- The per-host overlay is not version-controlled, and the Studio's launch agent still predates the config (issue #26).

## Mesh over Cloudflare: adding a host

Each host is one Cloudflare Tunnel connector and one Access-protected hostname. Every value below is a placeholder
(`<host>`, `<zone>`, `<tunnel-id>`). Secrets go to `~/.dpi-mcp/access.env` (mode 0600), never to the repo or a command
line. Issues #10, #11, and #28 track making these steps reproducible.

1. **Serve the model server.** Install llama.cpp, put GGUF files in the host's models directory, write
   `llama/hosts.yaml` on the host, then run `just llama apply <host>` there.
2. **Tunnel ingress.** Add a rule for a one-level hostname to the host's tunnel, pointing at `http://localhost:8080`, and
   keep the host's SSH rule:
   `cf tunnels config update <tunnel-id> --tunnel-config-ingress '[{"hostname":"<host>-llm.<zone>","service":"http://localhost:8080"},{"service":"http_status:404"}]'`
3. **DNS.** A proxied CNAME `<host>-llm.<zone>` → `<tunnel-id>.cfargotunnel.com`. Use a one-level name: Universal SSL
   covers `*.<zone>` only, so a two-level name fails the TLS handshake.
4. **Access.** A reusable policy with `decision: non_identity` and `include: [{"any_valid_service_token": {}}]`, and a
   self-hosted application on the hostname with that policy. `service_auth_401_redirect: true` makes a missing token a
   plain `401`.
5. **Service token.** `cf zero-trust access service-tokens create --name <name> --duration 8760h`. Write
   `CF_ACCESS_<HOST>=<client_id>:<client_secret>` to `~/.dpi-mcp/access.env`.
6. **Mesh file.** Add the host to `apps/dpi-mcp/mesh.json` (copy `mesh.example.json`).
7. **Verify.** `curl` without headers returns `401`; with the two `CF-Access-*` headers it returns `{"status":"ok"}`.
   Then `just llama drift <host> <url>` (set `DPI_LLAMA_ACCESS_ENV` to the variable's name) and `discover_models` list
   the host's models.

Access applications and tokens are created with the `cf` CLI's account login. The API token in `dpi-network.yaml` is
scoped for tunnels and DNS, not Access.

## Auto-discover / auto-implement

The tool store is data derived from each host's own API, not hand-written configuration:

- `probeHost` reads `/health` and `/v1/models`. Each model's `output_modalities` decides whether it becomes a chat tool
  or a decision tool. Its served window comes from the server's own arguments, never from its trained length.
- Discovery adds every model as a **disabled** tool. `enable_tool` serves it, and `ask_model` selects among the
  enabled tools by the tags a caller requires.
- A new host kind adds one probe and one tool kind. Browsers, speech, or image models use the same
  `discover → enable → ask` loop.

## Remaining work (ordered)

1. **Apply the llama config on the Studio** (issue #26): `just llama apply <host>` on that machine, then
   `just llama drift` must be clean.
2. **Add a tool-use probe per model**, so the tool store can tag which models answer agent tool calls correctly.
3. **Run the durable factory on the mesh.** Run `create-app` with `DPI_PROVIDER=mesh` and check its metered calls. The
   roster's `provider`/`model` fields are advisory: the device's `DPI_PROVIDER` decides the route.
4. **Expose zero bootstrap in the browser.** Verify discovery, approval and enablement, then prove the full local-only
   factory job from the hub and isolated browser box. Verify the installed iOS PWA over the Access-protected HTTPS route.

See `apps/dpi-mcp/README.md` for the tool list and `docs/tsf-factory-design.md` for the phase graph.
