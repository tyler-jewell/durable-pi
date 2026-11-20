# Agent instructions

This repository is **public-ready**. Never commit anything that ties it to one machine or leaks a secret:

- No hardcoded local paths (`/Users/<name>`, `/home/<name>`, `~/dpi-work`, etc.) — use `~`, environment variables, or derive paths at runtime.
- No secrets in code or docs (`dpi_*`, `cfat_*`/`cfut_*`, `sk-*`, `Bearer …`, API keys, passwords) — read them from the environment or a gitignored file, and reference them as `<NAME>` in committed examples.
- No machine-specific hostnames, ports, or usernames — use the config files (`dpi-network.example.yaml`, `.env.example`) and placeholders.
- No model names at all in the repo: no local model, no cloud model, no decision model, no catalog ID, no quantization tag. Names come from discovery (`discover_cloud`, the zero bootstrap), and `just names` ratchets the count down to zero. The only exemption is `apps/dpi-mcp/tests/naming-fixtures.ts`, which spells the naming convention once for the parser tests.
- No hardcoded model IDs, provider catalogs, or default models, and no local-vs-cloud model providers — every model is an MCP tool. Local and cloud models are served as tools of the same server, `ask_model` picks among the enabled tools by the tags a caller requires (A/B random by default), and the agent can always call one by name.
- Comments describe what the code does now. Never write about a migration, a removed, renamed or merged thing, what something used to be, what it replaces, or what was "no longer" true. Migration notes belong in the commit message, not in the code.
- Never add files to version control that significantly affect the artifact release pipeline (build/check/test), and never increase total pipeline time by more than 5% of the baseline.

## Tool calls are never silently cut

A model answer that hits its output limit is flagged `truncated` in every surface that returns it, and a truncated tool call is never executed. A context window is shared by the prompt and the output, so a request must fit the window the server actually runs, not the one a config claims.

## See something, say something

When you notice a bug, a missing tool, a bad pattern, or an improvement worth making, **do not silently log it or leave it as a TODO** — send it off for work immediately as a durable job:

```text
run_durable_job feedback { "observation": "...what you saw, with evidence..." }
```

The `feedback` job runs `triage → work → review → deploy`: a subagent turns the observation into a change, another makes it, and the **`review` phase is the same `reviewVerdict()` jev-quality gate every job uses** — it returns *approve*, *revise* or *reject*. An approval deploys; a denial is the review's own reason (the root cause of *why* it was denied), and *revise* loops the change back through `work`. Follow it with `check_durable_job`. That is the loop, and it is one shared work structure — not a separate state machine.
