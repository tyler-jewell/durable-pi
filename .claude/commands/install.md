---
description: Install Durable Pi: prerequisites, .env, app dependencies, the web UI build and this machine's device config
---

# Install Durable Pi (Durable Agent Network)

## Purpose

Set up this checkout so this machine can run a `dpi-backend` device, the web hub and the terminal client. Check prerequisites, confirm the OpenRouter key, install the four network apps, build the web UI, write this machine's device config, and verify with the test suite. This is an interactive, agentic process: ask the user when a choice is needed.

## Variables

SOURCE_REPO: the directory this command runs from (the repo root, where `justfile` lives)
NETWORK_FILE: `dpi-network.yaml` (gitignored device declarations; template `dpi-network.example.yaml`; every `just net` recipe takes an id from it)
ENV_FILE: `.env` at the repo root (template: `.env.example`)
DEVICE_HOME: `~/.dpi` (`backend.env` with the device token, `backend/` data, `network.sqlite` hub registry)
APPS: `apps/dpi-sdk`, `apps/dpi-backend`, `apps/dpi-playground`, `apps/dpi-tui`

## Codebase Structure

```text
justfile                 # groups: net, backend, hub, tui, test (just/<group>/mod.just)
dpi-network.example.yaml # template: defaults + the local device, commented ssh, exe-dev, apple-container and macos-vm examples
.env.example             # provider keys (OpenRouter, DeepSeek, Cloudflare) + optional Jev settings
apps/dpi-sdk/            # contract, client, models, registry, ops drivers (scripts/net.ts)
apps/dpi-backend/        # the device server (port 4780)
apps/dpi-playground/     # hub + Vue web UI (port 4781)
apps/dpi-tui/            # terminal client
```

## Instructions

- Run every check via Bash. Do not assume anything is installed.
- Show a status line right after each check (pass or fail).
- Install auto-installable items without asking. Ask the user before anything that needs their input.
- Never read, print or echo an API key value. Only confirm that it is set.
- Never start servers or long-running processes (`just backend run`, `just hub start`, `just tui attach`). Only verify readiness.
- Do not run `just net up` for any device except `local`. Remote devices need the user's own ssh hosts or exe.dev account, so leave them for the user to add.
- Do not run the device suites (`just test device`, `just test e2e`): they call a real model and cost money.

## Workflow

### Step 1 — Check Prerequisites

Critical, so stop and guide the user if any is missing:

1. `command -v node && node -v`: Node.js **26 or newer** (the backend uses `node:sqlite`). Install with nvm (https://github.com/nvm-sh/nvm): `nvm install 26 && nvm use 26`, or from https://nodejs.org.
2. `command -v npm && npm -v`.
3. `command -v just && just --version`: install with `brew install just` or see https://github.com/casey/just.
4. `command -v zsh`: every `just` recipe runs in zsh. macOS ships it; on Linux install it with `sudo apt install zsh` (or your package manager).
5. `command -v git`.

Optional, so report them and continue:

6. `command -v ssh && command -v rsync`: needed only to deploy to `ssh`, `exe-dev` or `macos-vm` devices.
7. `command -v tmux`: the TUI smoke test and the e2e scenario (`just test smoke`, `just test e2e`). `brew install tmux`.
8. Google Chrome (`test -d "/Applications/Google Chrome.app"` on macOS, `command -v google-chrome` on Linux): the Playwright UI suites drive installed Chrome. https://www.google.com/chrome/
9. `command -v curl && command -v sqlite3 && command -v openssl`: the one-request curl recipe and the smoke script.

### Step 2 — Check Environment

1. If `.env` is missing, copy the template: `cp .env.example .env`. Ask the user which model provider they want, then have them set the matching key(s) in `.env` (never ask for a key value in chat):
   - OpenRouter (default): `OPENROUTER_API_KEY` — https://openrouter.ai/keys
   - DeepSeek: `DEEPSEEK_API_KEY` — https://platform.deepseek.com
   - Cloudflare AI Gateway: `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` — https://developers.cloudflare.com/ai-gateway
2. Confirm the chosen key is set without printing it. For OpenRouter: `grep -Eq '^OPENROUTER_API_KEY=sk-' .env && echo set || ([ -n "$OPENROUTER_API_KEY" ] && echo "set in environment") || echo missing`; likewise `grep -Eq '^DEEPSEEK_API_KEY=.+' .env` for DeepSeek, and all three `grep -Eq '^CLOUDFLARE_(API_KEY|ACCOUNT_ID|GATEWAY_ID)=.+' .env` for the gateway.
3. If no key is available and the user wants to continue, tell them the backend can run with the free deterministic model: `DPI_PROVIDER=faux just backend run`.

### Step 3 — Install Dependencies

1. `just install`: `npm install` in the four network apps.

### Step 4 — Verify Configuration

1. If `dpi-network.yaml` is missing, create it: `cp dpi-network.example.yaml dpi-network.yaml`. Never overwrite an existing one.
2. `just net ids`: the file parses and lists device ids. Confirm `local` is among them.
3. `just net up local`: writes `~/.dpi/backend.env` with a fresh `DPI_TOKEN` (or keeps an existing one), copies the keys named in `env_keys` (the provider key(s) from `.env`), and registers the device in `~/.dpi/network.sqlite`. For DeepSeek set `env_keys: [DEEPSEEK_API_KEY]` in `dpi-network.yaml`; for Cloudflare AI Gateway set `env_keys: [CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID]` and add `DPI_PROVIDER: cloudflare-ai-gateway` under the device's `env`. Then confirm `test -f ~/.dpi/backend.env && stat -f '%Lp' ~/.dpi/backend.env` (Linux: `stat -c '%a'`) shows `600`. Never print the file.
4. `just hub build`: type-checks and builds the web UI that `just hub start` serves.
5. Tell the user that new sessions start in `~/dpi-work` (created by `just net up local`) unless they set `start_dirs`, that any existing folder on the device works as a session cwd, and that other machines are added by uncommenting the `ssh`, `exe-dev`, `apple-container` or `macos-vm` example in `dpi-network.yaml` and running `just net up <id>`.

### Step 5 — Verify Readiness

1. `just --list`: shows the groups net, backend, hub, tui and test.
2. `just check`: type checks and unit tests for every app. They use the faux model, so they need no network and cost nothing (under a minute).
3. Optional, if Chrome is installed: `just test ui`, the 28-check web UI suite against two faux devices (under a minute).

### Step 6 — Report

Print a table with one row per check: each required prerequisite (node, npm, just, zsh, git), the `.env` key, `just install`, `just net ids`, `just net up local`, `just hub build`, `just check` and the optional items. Mark each `pass`, `fail` or `skipped`, then give a ready count (for example `11 of 11 required checks pass`).

Next steps, in order (each in its own terminal):

```bash
just backend run              # this machine's device server on :4780
just hub start                # web UI: http://localhost:4781
just tui attach local         # terminal client on the same device
just net status               # probe every device in dpi-network.yaml
just net up <id>              # after uncommenting an ssh, exe-dev, apple-container or macos-vm example in dpi-network.yaml
```

### Self-verify

After each step, the pass line is the proof. Do not continue past a failed required step.

| Step | Pass |
|---|---|
| prerequisites | each `command -v` prints a path, and `node -v` is 26 or newer |
| `.env` | the chosen key check prints `set`, and the value is not printed |
| `just install` | the command exits 0 |
| `just net ids` | `local` is in the list |
| `just net up local` | `~/.dpi/backend.env` exists and its mode is `600` |
| `just hub build` | the command exits 0 |
| `just verify-setup` | three `PASS` lines and exit 0 |
| `just check` | exit 0 |

`just lsp test` is the proof that the language servers installed. `just net status` is the proof after a device is up. Neither starts a server by itself. A non-zero exit is a failed install.
