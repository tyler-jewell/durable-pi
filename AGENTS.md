# Agent instructions

This repository is **public-ready**. Never commit anything that ties it to one machine or leaks a secret:

- No hardcoded local paths (`/Users/<name>`, `/home/<name>`, `~/dpi-work`, etc.) — use `~`, environment variables, or derive paths at runtime.
- No secrets in code or docs (`dpi_*`, `cfat_*`/`cfut_*`, `sk-*`, `Bearer …`, API keys, passwords) — read them from the environment or a gitignored file, and reference them as `<NAME>` in committed examples.
- No machine-specific hostnames, ports, or usernames — use the config files (`dpi-network.example.yaml`, `.env.example`) and placeholders.
- No hardcoded model IDs, provider catalogs, or default models, and no local-vs-cloud model providers — model access is funneled through the MCP capability registry (`run_llm`/`run_decision`), which defaults to local, can use cloud, and lets the agent choose, always reflecting the current system.
- Never add files to version control that significantly affect the artifact release pipeline (build/check/test), and never increase total pipeline time by more than 5% of the baseline.

## See something, say something

When you notice a bug, a missing capability, a bad pattern, or an improvement worth making, **do not silently log it or leave it as a TODO** — send it off for work immediately as a durable job:

```text
run_durable_job feedback { "observation": "...what you saw, with evidence..." }
```

The `feedback` job runs `triage → work → review → deploy`: a subagent turns the observation into a change, another makes it, and the **`review` phase is the same `reviewVerdict()` jev-quality gate every job uses** — it returns *approve*, *revise* or *reject*. An approval deploys; a denial is the review's own reason (the root cause of *why* it was denied), and *revise* loops the change back through `work`. Follow it with `check_durable_job`. That is the loop, and it is one shared work structure — not a separate state machine.
