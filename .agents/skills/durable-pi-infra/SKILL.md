---
name: durable-pi-infra
description: "Cloudflare and infrastructure rules for this repo: the cf CLI, verifying the account before a write, R2 state and S3 credentials, API-token and Access service-token management, the Terraform mesh in infra/, the credential inventory, and the Cloudflare Tunnel and Access routes to hosts. Use before any Cloudflare, Terraform, mesh-host, or credential work in durable-pi."
---

# durable-pi infrastructure

## Cloudflare CLI and admin

- When interacting with Cloudflare, use the `cf` CLI unless the project has a Wrangler configuration file.
- **Config-driven admin, not the dashboard.** Prefer a documented, reproducible action: `cf`, the Cloudflare API, or Terraform. Before calling something dashboard-only, check `cf cli search "<task>"`, `cf schema <command>`, `cf docs search "<question>"`, and the API reference. Send a human to the dashboard only when all of them say so, and record the steps and why they cannot be automated.
- **Verify the account before every write.** `cf auth whoami` must show the personal account whose id is `CLOUDFLARE_ACCOUNT_ID` in the git-ignored `.env`. Never write to another account.
- **Keep identifiers out of committed files and out of search queries.** No account ids, emails, zone ids, or token values in tracked files, commit messages, or `cf` search text. Use `<account-id>` placeholders in examples.

## Credentials

- The inventory is `docs/cloudflare-credentials.md`: every Cloudflare credential, where it lives, and how to rotate it. Read it before touching one.
- Secrets live in the git-ignored `.env` (mode 0600) or the Keychain. `dpi-network.yaml` lists the names of secrets under `env_keys`; the values are copied from `.env` by `just net up`.
- **R2 S3 credentials** are derived from a standard API token, not created in the dashboard: create a token with the `Workers R2 Storage` permission, use its `id` as the Access Key ID, and the SHA-256 hex of its `value` as the Secret Access Key. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
- **API-token management** (create, list, delete) needs `Account API Tokens`: Edit to create or delete, Read to list. The interactive login may hold only Read, so a 403 on delete means fix the permission, not the dashboard.
- **Access service tokens** are managed with `cf zero-trust access service-tokens …`. The client secret is shown once. Rotate with `cf`, write the new `client_id:client_secret` to the mesh access file, verify, and only then revoke the old token. Never re-import a lost secret.

## Terraform (`infra/`)

- `infra/` owns the Cloudflare mesh: the tunnel, DNS, the Access applications and policies, and the short-lived SSH certificate authority.
- State is in a private R2 bucket. The endpoint carries the account id, so it comes from `infra/backend.hcl` (git-ignored; copy `backend.hcl.example`): `terraform init -reconfigure -backend-config=backend.hcl`.
- Credentials come from the environment (the R2 token's three values), never a committed file.
- Plan and apply mesh changes. Do not edit them in the dashboard.

## Mesh hosts

- Each host runs one Cloudflare Tunnel connector and one Access-protected one-level hostname that reaches its loopback model server. The step-by-step runbook is in `docs/local-factory.md` (Mesh over Cloudflare).
- Host SSH goes through Cloudflare Access, not Tailscale. The interactive login caches a token locally; when it expires, a human re-authenticates. Non-interactive callers (the mesh-health MCP) use a Cloudflare service token from the Keychain, and the LLM endpoints accept only the two tokens named in `infra/llm.tf`.
- Each host's model server is configured by `llama/config.yaml` (shared) and `llama/hosts.yaml` (per host, git-ignored). Check drift with `just llama drift <host> <url>` after any change.
- Hostnames, account ids, and service-token names never go in a committed file. Use `mesh.example.json` and `hosts.example.yaml` as templates.
