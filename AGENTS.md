# Agent instructions

This repository is **public-ready**. Never commit anything that ties it to one machine or leaks a secret:

- No hardcoded local paths (`/Users/<name>`, `/home/<name>`, `~/dpi-work`, etc.) — use `~`, environment variables, or derive paths at runtime.
- No secrets in code or docs (`dpi_*`, `cfat_*`/`cfut_*`, `sk-*`, `Bearer …`, API keys, passwords) — read them from the environment or a gitignored file, and reference them as `<NAME>` in committed examples.
- No machine-specific hostnames, ports, or usernames — use the config files (`dpi-network.example.yaml`, `.env.example`) and placeholders.
- Never add files to version control that significantly affect the artifact release pipeline (build/check/test), and never increase total pipeline time by more than 5% of the baseline.
