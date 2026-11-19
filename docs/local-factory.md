# The local-only software factory (Studio on the mesh)

The `.tsf` factory (`create-app` durable job) run **entirely on the Studio**, using the
Studio's own local LLMs for the coding agents and its local Jev/Clef decision models for the
`jev-quality` reviewer gate — no cloud model calls. This doc records what was validated, what
is built, and what remains.

## Validated resources (19 Nov 2026)

`studio.tail9d6cad.ts.net` (Apple M1 Max, 32 GB) runs **llama.cpp `llama-server` 1.0.0**.
The canonical model root is `~/local/models/` (manifest.json is the SSoT; see
docs/model-lineup.md), and one router on `:8080` serves one GGUF at a time from
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
├── dpi-mcp          MCP tools (create_app/check/test/push + capability lifecycle)
└── llama-server     8080 (router, one GGUF at a time from ~/local/models/gguf)
```

- **Coding agents** (planner/builder/scout/reviewer/documenter) need a *text* model with
  tool calling. `dpi-backend` routes every agent through one provider (`DPI_PROVIDER`); a new
  `local` provider (OpenAI-compatible → `LLAMA_BASE_URL`) is the only backend change.
- **`jev-quality`** (step 3, implemented) already calls `askJev`; setting
  `JEV_BASE_URL=http://127.0.0.1:8080/v1/systemone` and `JEV_MODEL=Clef-Flash-Q4_K_M`
  routes it to the local Clef with **no code change** — the System One envelope llama.cpp
  serves matches `dpi-backend/src/jev.ts` exactly. The reviewer gate fails open to the model
  reviewer when Jev is unreachable, so a sleeping model server never blocks a run.

## What is built

1. **Step 3 — `jev-quality`** (`dpi-backend/src/jobs.ts`): the review phase asks the local
   Jev a bounded `choice` (approve/revise/reject) on `{ plan, facts, review }`; `approve`
   passes, anything else fails the run, and an unreachable Jev fails open to the model
   reviewer. `reviewVerdict()` is exported + unit-tested (`tsf.test.ts`, 25 backend tests).
2. **Per-host capability registry + MCP lifecycle** (`dpi-mcp/src/capabilities.ts`,
   `capability-tools.ts`, `host-inspect.ts`): agents drive discovery and enablement with MCP
   tools alone — `discover_host` → `inspect_host` (ssh: config + launchd auto-start + a live
   test) → `list_models` → `recommend_capability` → `enable_capability` (with `autoEnable`,
   auto-turn-on) or leave it `recommended` in `list_capabilities` for a later settings toggle
   → `run_llm` / `run_decision`. Registry at `~/.dpi-mcp/capabilities.json`
   (`DPI_MCP_CAPABILITIES` override). The core eval `tests/zero-agent.eval.ts` proves the
   whole loop offline: a zero-code-base agent, given only a host address + ssh target,
   identifies the decision models/server/config/launchd auto-start, tests it live, proposes,
   and — only if the config is right — is approved and validated with auto-turn-on set. 5 unit
   tests + 1 eval.
3. **`local` provider** (`dpi-backend/src/providers.ts`): `DPI_PROVIDER=local` routes every
   coding agent to an ambient OpenAI-compatible endpoint (`LLAMA_BASE_URL`, default
   `http://127.0.0.1:8080/v1`) with two text-model aliases (Qwen3 Coder 8B, DeepSeek Coder V2
   Lite). No credentials. The browser trigger is wired too: the Main agent's prompt maps
   `create app: <description>` → `run_durable_job create-app`. `dpi-network.example.yaml`
   shows the Studio device stanza that turns this on.

## Auto-discover / auto-implement

The registry is **data derived from the host's own API**, not hand-written config:

- `probeHost` reads `/health` + `/v1/models`; llama.cpp 1.0.0 already reports each model's
  `output_modalities`, so `text` → `llm` and `decisions` → `decision` fall out of the probe.
- `recommend_capability` turns a discovered model into a `Capability` with a `purpose`
  (e.g. `["jev-quality"]`), `inputs` and `options`, in state `recommended`.
- `enable_capability` supplies inputs/options and sets `enabled`; `resolveCapability(reg,
  purpose)` is the single in-process binding the factory consumes. A `decision` capability
  with `purpose: ["jev-quality"]` is what the reviewer gate should prefer over env vars.
- A future host kind adds **one probe spec + one capability kind** — browsers, speech,
  image models — and the same `discover → recommend → enable → run_*` loop applies.

## Remaining work (ordered)

1. **Add a coding LLM to the Studio.** Download a text+tool-calling GGUF (a ~8–14B Q4 model
   fits the 32 GB box beside Clef-Flash; the `local` provider lists Qwen3 Coder 8B and
   DeepSeek Coder V2 Lite as the expected aliases) into
   `~/local/models/gguf`, and let the 8080 router serve it. This is a deliberate
   choice (model, size, quantization); pick it explicitly before a multi-GB download.
2. ~~`local` provider~~ — done (step 3 above).
3. **Mesh reachability.** `llama-server` binds `127.0.0.1` today, so other hosts (MacBook,
   iPhone) cannot reach the Studio's models. For the factory itself this is fine (it runs on
   the Studio); to let *all* agents use the MCP `run_llm`/`run_decision` tools from anywhere,
   run `tailscale serve --bg --https 8443 8080` on the Studio (HTTPS + tailnet ACL) or restart
   the server with `--host 0.0.0.0`. Then re-run `discover_host` with the mesh URL. Note the
   Studio's existing serve already proxies `/` → 127.0.0.1:8464, so use a separate https port.
4. **PWA on iOS.** Serve the hub UI (`apps/dpi-playground`) from the Studio over HTTPS
   (Tailscale Serve gives that), and add a web app manifest + service worker + Apple touch
   icon so "Add to Home Screen" installs it as a standalone app. The hub already serves the
   Vue frontend; the manifest/worker/icons are the new bits, plus iOS Safari specifics
   (`apple-mobile-web-app-capable`, full-screen `display: standalone`, no service-worker
   assumptions on iOS).
5. **Bind the factory to enabled capabilities.** Once `local` (step 2) and the capability
   lifecycle exist, have the reviewer phase prefer `resolveCapability("jev-quality")` over
   raw env, and the coding agents prefer the enabled `llm` capability — the last "auto-
   implement" stitch.

See `apps/dpi-mcp/README.md` for the tool list and `docs/tsf-factory-design.md` for the
phase graph.
