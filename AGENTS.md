# Agent instructions

This repository is **public-ready**. Never commit anything that ties it to one machine or leaks a secret:

- No hardcoded local paths (`/Users/<name>`, `/home/<name>`, `~/dpi-work`, etc.) — use `~`, environment variables, or derive paths at runtime.
- No secrets in code or docs (`dpi_*`, `cfat_*`/`cfut_*`, `sk-*`, `Bearer …`, API keys, passwords) — read them from the environment or a gitignored file, and reference them as `<NAME>` in committed examples.
- No machine-specific hostnames, ports, or usernames — use the config files (`dpi-network.example.yaml`, `.env.example`) and placeholders.
- No model names at all in the repo: no local model, no cloud model, no decision model, no catalog ID, no quantization tag. Names come from discovery (`discover_models`, the zero bootstrap), and `just names` ratchets the count down to zero. The only exemption is `apps/dpi-mcp/tests/naming-fixtures.ts`, which spells the naming convention once for the parser tests.
- No hardcoded model IDs, provider catalogs, or default models, and no local-vs-cloud model providers — every model is an MCP tool. Local and cloud models are served as tools of the same server, `ask_model` picks among the enabled tools by the tags a caller requires (A/B random by default), and the agent can always call one by name.
- Comments describe what the code does now. Never write about a migration, a removed, renamed or merged thing, what something used to be, what it replaces, or what was "no longer" true. Migration notes belong in the commit message, not in the code.
- Never add files to version control that significantly affect the artifact release pipeline (build/check/test), and never increase total pipeline time by more than 5% of the baseline.

## A result needs its evidence

A task is done only with evidence of the tool calls and artifacts that produced it. A review checks that evidence, not a summary.

## Truncated answers are errors

A cut-off model answer is reported as cut off everywhere it appears, and its tool calls never run. The architecture is in the `durable-pi-architecture` skill.

## See something, say something

When you notice a bug, a missing tool, a bad pattern, or an improvement worth making, send it off as a durable job; do not log it or leave a TODO:

```text
run_durable_job feedback { "observation": "...what you saw, with evidence..." }
```

Follow it with `check_durable_job`. The loop and its review gate are described in the `durable-pi-architecture` skill.

## Infrastructure, Cloudflare, and architecture

Cloudflare, Terraform, credentials, and mesh hosts are described in the `durable-pi-infra` skill. The system's architecture (jobs, the review gate, model routing, the llama config, and the checks) is in the `durable-pi-architecture` skill. Read the relevant skill before changing either.

## Pi tooling

- `find` patterns are relative to `path`. From a monorepo root, pass `path: "apps/dpi-tui"` with `src/**/*.ts`, or use `**/src/**/*.ts` to match at any depth. A pattern with no `/` matches file names at any depth.
- MCP tools on `codemode` servers are not in the tool list. Find them with `searchTools("…")` and read their signatures with `describeTool(name)` inside a `codemode` script. `direct` servers appear as tools.
- Never change the hooks path, pass `--no-verify`, or set a `SKIP` variable to get a commit through. The LSP extension blocks those commands, and the git gate is the only way in (`pi/lsp/README.md`).
- Before starting a pi child, read `.pi/skills/pi-subagents/SKILL.md`. Discover models at runtime with `pi --list-models`; pass `--model provider/id` from that output. Never write the chosen name into tracked files, commit messages, or this file.
- A coding child uses `pi --mode json -p --no-session --model <provider>/<id> --tools <allowlist>`. Add `--no-mcp` unless MCP is needed; never pass `--no-extensions`. Use only flags listed by `pi --help`; `--json` and `--no-tui` are not pi flags.
- A run finishes at `agent_settled` or process exit; its answer is the last assistant `message_end`. Sum `message.usage.cost.total` across those events. `dpi-mcp ask_model` is a metered model-tool call and does not edit the repo; a pi child is for reads and edits.
- For isolated parallel edits, follow the procedure in `.pi/skills/pi-subagents/SKILL.md`.
- Packages are not updated at startup (pi 0.60.0). `pi update --extensions` updates packages, and `pi update --self` updates pi. `pi mcp list --json` reports `resources: true` for a server that offers resources; nothing in this repo parses that output.
