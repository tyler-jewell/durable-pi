# Scaffold and verify web apps: Vue, Vite, offline-first PWA, responsive. Checked in a browser against Modern Web Guidance.
set shell := ["zsh", "-cu"]
set positional-arguments

# List app recipes
[default]
[no-cd]
default:
    @just --list app

# Create an app, or add a route or a page to one.
#   just app add app <name> ["Title"]
#   just app add route <app> </path> <Name>
#   just app add page <app> <Name>
[no-cd]
add *args:
    @npx --yes tsx@4.22.0 scripts/app.mts add "$@"

# Type-check, build, and verify an app in a browser. Report: ~/.dpi/app-verify/<app>/<run>/report.md
[no-cd]
verify app:
    npx --yes tsx@4.22.0 scripts/app-verify.mts {{app}}
