# Durable Pi. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from dpi-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# Local runtime state: missing files and loose permissions, never file contents
mod doctor 'just/doctor'

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

# The .tsf software factory: stamp the roster + prompts
mod tsf 'just/tsf'

# llama.cpp on this host and the mesh: render, check, compare and apply llama/config.yaml
mod llama 'just/llama'

# Agent skills: restore (default), add, search, remove, list. Pins live in skills-lock.json
mod skills 'just/skills'


# List command groups
default:
    @just --list

# One-time setup for this clone: the pre-commit gate (every commit is checked by the language servers), and the servers
setup:
    git config core.hooksPath .githooks
    sh pi/lsp/install.sh .
    # Type-check packages for the folders the gate checks (their node_modules are not in git).
    cd pi/extensions/lsp && npm install --no-audit --no-fund
    @echo "setup: pre-commit gate installed (core.hooksPath=.githooks); servers and type packages installed"

verify-setup:
    @test "$(git config --get core.hooksPath)" = ".githooks" && echo "PASS: git hooks path is .githooks"
    @test -f pi/extensions/lsp/index.ts && echo "PASS: LSP extension exists"
    @command -v node >/dev/null 2>&1 && echo "PASS: node is on PATH"

# Install dependencies for every network app
install:
    cd apps/dpi-sdk && npm install --no-audit --no-fund
    cd apps/dpi-backend && npm install --no-audit --no-fund
    cd apps/dpi-playground && npm install --no-audit --no-fund
    cd apps/dpi-tui && npm install --no-audit --no-fund
    cd apps/dpi-mcp && npm install --no-audit --no-fund
    cd apps/base-app && npm install --no-audit --no-fund
    cd apps/pi-object && npm install --no-audit --no-fund && npm run types
    cd apps/pi-object/e2e && npm install --no-audit --no-fund
    cd scripts && npm install --no-audit --no-fund
    cd pi/lsp/check && npm install --no-audit --no-fund

# Declared copies of shared files must match their sources (scripts/check-copies.mts)
copies:
    node scripts/check-copies.mts

# The repo holds no model names: the ratchet only goes down (scripts/check-zero-names.mts)
names:
    npx tsx scripts/check-zero-names.mts

# Type checks and unit tests, every app
check: copies names test::unit llama::test

# Vue type check on another TypeScript, in a clean container (default 7.0.2; TS_VERSION=5.9.3 is the control)
ts-probe *args:
    scripts/vue-ts-probe.sh {{args}}
