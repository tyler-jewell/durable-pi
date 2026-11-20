---
name: durable-pi-architecture
description: "The durable-pi system: how the backend's durable jobs and review gate work, how dpi-mcp serves every model as a tool and routes calls, the mesh model provider, the LSP gate, the device inventory, and where each piece lives. Use before changing the backend, the MCP server, model routing, the review or feedback loop, or the checks that gate a commit."
---

# durable-pi architecture

## Repo map

- `apps/dpi-backend`: the durable device server. Jobs (`src/jobs.ts`), the model providers (`src/providers.ts`, `src/mesh-provider.ts`), the review gate client (`src/jev.ts`, `src/mesh.ts`), and the read-only shell (`src/read-only.ts`).
- `apps/dpi-mcp`: the MCP server. Model discovery, the tool store, `ask_model`, the usage meter, the app tools.
- `apps/dpi-sdk`, `apps/dpi-tui`, `apps/dpi-playground`: clients of the device API.
- `apps/pi-object`: a Durable Object worker with its own cost meter.
- `llama/`: the llama.cpp server definition for each host. `scripts/llama.mts` renders, checks, compares, and applies it.
- `pi/extensions/lsp`, `pi/lsp`: the LSP tooling and the git gate.
- `dpi-network.example.yaml`: the device inventory; `dpi-network.yaml` is the git-ignored local copy.

## Durable jobs and the review gate

- A job is a checkpointed run with named phases. `create-app` runs `plan → build → scout → test → review → document → deploy`. `feedback` runs `triage → work → review → deploy`. A restart resumes the unfinished phase.
- One subagent serves the whole run. Each phase sets its own extension and instructions on that subagent, so a phase never keeps the tools of an earlier one.
- Tool sets: planner, scout, reviewer, and triager get `ReadOnlyTools` (read, and a shell that refuses writes, chaining, redirection, and substitution). The documenter gets `DocumentTools` (read, write, edit, and the read-only shell). The builder and the work phase get `CodingTools`.
- Artifact guards: `build` fails if no file was written; `document` fails unless `README.md` exists. Phase summaries are not evidence; files are.
- The review gate asks an enabled decision tool, through MCP, for `approve | revise | reject` on the plan, facts, and reviewer verdict. `reviewVerdict()` passes an approval and blocks a confident revise or reject. A low-confidence or missing decision leaves the reviewer's verdict in effect. The verdict is read through markdown and a label (`verdictOf()`).
- The `feedback` job is the "see something, say something" loop: an observation becomes a durable job, and its review is the same gate.

## Model access

- Every model is an MCP tool on dpi-mcp. Discovery adds each model as a disabled tool; `enable_tool` serves it; `probe_tool_use` checks that it returns structured tool calls.
- `ask_model` picks among enabled tools whose tags include every required tag (A/B random by default), or calls one by name. A chat turn that offers tools requires the `tool-use` tag.
- The meter (`list_usage`, `compare_costs`) records every MCP model call. Pi's own generated profiles call endpoints directly and do not pass through the meter.
- `DPI_PROVIDER=mesh` makes every backend agent turn an `ask_model` call. Other providers are OpenRouter, DeepSeek, Cloudflare AI Gateway, and the deterministic faux provider for tests.
- Truncation: a model answer that hits its output limit is flagged `truncated` everywhere it is returned, its tool calls are withheld, and the provider reports it as an error. A context window is shared by the prompt and the output, so each request is checked against the window the server actually runs.

## Checks that gate a commit

- The pre-commit gate (`pi/extensions/lsp/gate.mjs`) runs the language servers on staged, Git-tracked files only. Its toolchain is `~/.dpi/lsp-tools`.
- `just check` runs the names ratchet, the copies check, the unit tests of every app, and the llama tests.
- `just names` must not grow the count of model names in the repo.

## Pi integration

- The pi packages are pinned exactly (`@earendil-works/*`) in each app's `package.json`. Upgrading means changing every pin and running the affected suites.
- The LSP extension for Pi is not installed globally. It is re-implemented per project; until then, the repo's gate is the only LSP check.
