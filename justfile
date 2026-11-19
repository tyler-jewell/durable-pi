# Durable Pi. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from dpi-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# Web apps: scaffold from templates, add routes and pages, verify in a browser
mod app 'just/app'

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

# Install dependencies for every network app
install:
    cd apps/dpi-sdk && npm install --no-audit --no-fund
    cd apps/dpi-backend && npm install --no-audit --no-fund
    cd apps/dpi-playground && npm install --no-audit --no-fund
    cd apps/dpi-tui && npm install --no-audit --no-fund

# Type checks and unit tests, every app
check: test::unit

# Vue type check on another TypeScript, in a clean container (default 7.0.2; TS_VERSION=5.9.3 is the control)
ts-probe *args:
    scripts/vue-ts-probe.sh {{args}}
