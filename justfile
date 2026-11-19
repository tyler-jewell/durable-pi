# Durable Pi. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from dpi-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# Web apps: scaffold from templates, add routes and pages, verify in a browser
mod app 'just/app'

# Language servers and the git gate: pre-commit checks, pinned install, tests
mod lsp 'just/lsp'

# This machine's dpi-backend
mod backend 'just/backend'

# Web UI hub on port 4781
mod hub 'just/hub'

# Terminal client for one device
mod tui 'just/tui'

# Unit, UI, device and e2e suites
mod test 'just/test'

# Proactive DPI demo: just proactive <command>
mod proactive 'just/proactive'

# List command groups
default:
    @just --list

# One-time setup for this clone: the pre-commit gate (every commit is checked by the language servers), and the servers
setup:
    git config core.hooksPath .githooks
    sh pi/lsp/install.sh .
    # Type-check packages for the folders the gate checks (their node_modules are not in git).
    cd pi/extensions/lsp && npm install --no-audit --no-fund
    cd pi/lsp/eval && npm install --no-audit --no-fund
    @echo "setup: pre-commit gate installed (core.hooksPath=.githooks); servers and type packages installed"

# Install dependencies for every network app
install:
    cd apps/dpi-sdk && npm install --no-audit --no-fund
    cd apps/dpi-backend && npm install --no-audit --no-fund
    cd apps/dpi-playground && npm install --no-audit --no-fund
    cd apps/dpi-tui && npm install --no-audit --no-fund
    cd apps/base-app && npm install --no-audit --no-fund
    cd apps/pi-object && npm install --no-audit --no-fund && npm run types
    cd apps/pi-object/e2e && npm install --no-audit --no-fund
    cd apps/proactive-dpi-demo && npm install --no-audit --no-fund
    cd scripts && npm install --no-audit --no-fund
    cd pi/lsp/check && npm install --no-audit --no-fund

# Type checks and unit tests, every app
check: test::unit

# Vue type check on another TypeScript, in a clean container (default 7.0.2; TS_VERSION=5.9.3 is the control)
ts-probe *args:
    scripts/vue-ts-probe.sh {{args}}
