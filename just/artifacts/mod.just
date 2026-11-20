# Artifacts is the git server. Pushing also updates the public main branch.

set shell := ["zsh", "-cu"]
set positional-arguments

[default]
[no-cd]
default:
    @just --list artifacts

# Push HEAD to the Artifacts baseline, then update the public main branch.
[no-cd]
push:
    cd apps/dpi-mcp && npx tsx scripts/artifacts-push.mts
