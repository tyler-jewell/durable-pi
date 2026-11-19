# Cloudflare credentials inventory (personal account `09f27fe…`)

Single source of truth for every Cloudflare credential used by this repo:
what it is, where it lives, how to get/rotate it, and how to use it. All writes
are against the **personal** account (`vgrdz5h54y@privaterelay.appleid.com` /
account id `09f27fe672991450d128a652b5fb4d73`), never flagseeker.

There are **three** kinds of Cloudflare credential, managed in different places.
Do not confuse them.

| Kind | Where managed | cf CLI? | Example |
|---|---|---|---|
| **Access service token** (Zero Trust, SSH non-interactive lane) | `cf zero-trust access service-tokens …` | yes | `studio-ssh-agent` |
| **R2 account API token** (S3 Access Key + Secret) | dashboard **R2 → Manage R2 API Tokens → Account API tokens** | no (derive instead, see below) | `durable-pi-terraform-state` |
| **Cloudflare API token** (bearer for the API) | dashboard **My Profile → API Tokens** | create only (`cf user tokens create`) | `dpi-container` (account-owned), `durable-pi-terraform-tmp` |

## Current state (verified 2026-11-19)

Cleanup is complete: the four junk tokens below were deleted in the dashboard,
and the stale flagseeker Keychain items were removed. What remains is the keepers.

### Access service tokens (keep 1)

| Token | Id | Expiry | Fate |
|---|---|---|---|
| `studio-ssh-agent` | `8a69df5b-2551-4be2-9497-e7b12fb2bd9a` | 2027-11-19 | **Keep** — SSH non-interactive lane |

### R2 account API tokens (R2 dashboard → Account API tokens)

| Token | Scope | Fate |
|---|---|---|
| `durable-pi-terraform-state` | bucket `durable-pi-terraform-state`, Object R/W | **Keep** — Terraform state backend |
| `durable-pi-object deploy` | All buckets, Admin R/W | ~~Delete~~ **Deleted** ✅ |

### R2 user API tokens / Cloudflare API tokens (My Profile → API Tokens)

| Token | Scope | Fate |
|---|---|---|
| `durable-pi-terraform-tmp` | Tunnel / Access / DNS / Service Tokens | ~~Delete~~ **Deleted** ✅ (temp, served the state recovery) |
| `durable-pi-r2-derive-test` | R2 Read | ~~Delete~~ **Deleted** ✅ (1-hour verification token) |
| `studio-reset-pipeline` | All buckets, Admin R/W | ~~Delete~~ **Deleted** ✅ (no reference in this repo) |
| `Workers Builds - 2026-11-07 13:35` | All buckets, Admin R/W | ~~Delete~~ **Deleted** ✅ (no Workers Builds config existed) |
| `dpi-container` (account-owned, `cfat_…`) | account | **Keep** — the container's API token for device/e2e runs |

> `cf user tokens list` and `cf user tokens delete` return `403 [9109]` from the
> interactive OAuth login (it can create but not list/delete). So the Cloudflare
> API token list above is from the dashboard; verify it against **My Profile →
> API Tokens** before deleting.

## Keychain (macOS) — what stays

| Service | Account | What | Used as |
|---|---|---|---|
| `cloudflare` | `default` | cf CLI OAuth session (personal) | `cf` commands |
| `cloudflare` | `personal` | cf CLI OAuth session (personal, named profile) | `cf --profile personal` |
| `durable-pi.cloudflare` | `dpi-container` | account-owned API token (`cfat_…`) | `CLOUDFLARE_API_TOKEN` in the device/e2e container |
| `durable-pi-terraform-r2` | `r2-access-key-id` | R2 S3 Access Key ID | `AWS_ACCESS_KEY_ID` |
| `durable-pi-terraform-r2` | `r2-secret-access-key` | R2 S3 Secret Access Key | `AWS_SECRET_ACCESS_KEY` |

Removed as stale (flagseeker, wrong account): `flagseeker-cloudflare/{macbook-pro,mbp}`,
`cloudflare/flagseeker`.

## How to get / rotate each keeper

### `studio-ssh-agent` (Access service token)
```sh
cf zero-trust access service-tokens list
cf zero-trust access service-tokens rotate <id>        # or create new + update infra var
```
Used by `infra/` via `var.service_token_id` (in gitignored `terraform.tfvars`) and
by the host bootstrap. Client secret is shown once — rotate, never re-import.

### `durable-pi-terraform-state` (R2 S3 for the state backend)
The dashboard "Manage R2 API Tokens" is **not** required. Derive the S3 pair from
a normal API token (verified against the bucket):

```sh
cf user tokens create --name terraform-state-r2 --expires-on <ISO> --policies @policies.json
# Access Key ID   = the token's id
# Secret Access Key = sha256hex(token value)
```
Then store:
```sh
security add-generic-password -U -a r2-access-key-id    -s durable-pi-terraform-r2 -w "<access key id>"
security add-generic-password -U -a r2-secret-access-key -s durable-pi-terraform-r2 -w "<secret>"
```
Used by Terraform's `backend "s3"` (no `AWS_SESSION_TOKEN`); endpoint
`https://09f27fe672991450d128a652b5fb4d73.r2.cloudflarestorage.com`.

### `dpi-container` (container API token)
Account-owned token created Nov 18 for the device/e2e container. To regenerate,
create a new account token from the dashboard (My Profile → API Tokens → account
tokens) or reuse the R2 derivation above for R2-scoped needs. Store under
`durable-pi.cloudflare` / `dpi-container`.

### Workers deploy token (for agents that deploy to Cloudflare)
`dpi-container` has Workers **Read** but not **Write**, so an agent cannot deploy
with it (see issue #23). For a deploy token, mint a temporary scoped one:

```sh
cf user tokens create --name durable-pi-e2e-deploy --expires-on <ISO> --policies @policies.json
# permission groups: Workers Scripts Read (1a71c399…) + Write (e086da7e…), Workers Routes Write (28f4b596…)
```
Give it to the device as `CLOUDFLARE_API_TOKEN`. Note: `wrangler delete` with this
scope errors on a KV-namespace check even though the worker is deleted (issue #24);
add `Workers KV Storage Read` (8b47d278…) to make delete exit cleanly.

## Admin work: config-driven or API, not the dashboard

Before concluding any Cloudflare action is "dashboard-only", check `cf cli search`,
`cf schema`, `cf docs search`, and the API reference (developers.cloudflare.com/api).
The R2 S3 credentials above are the worked example: they looked dashboard-only but
are derivable from a plain API token.
