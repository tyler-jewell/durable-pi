# Language servers and the git gate: the checks every commit passes, and the tests for them.
set shell := ["zsh", "-cu"]
set positional-arguments

# List language recipes
[default]
[no-cd]
default:
    @just --list lsp

# Install the language servers and pi's LSP extension on this machine (pinned; see pi/lsp/install.sh)
[no-cd]
install:
    sh pi/lsp/install.sh .

# Every file of every language must be clean by the servers' standard, across the whole repo
[no-cd]
check:
    node pi/extensions/lsp/gate.mjs all

# Test the gate end to end, and the agent check (pi's CLI with a scripted model)
[no-cd]
test:
    sh pi/lsp/gate-test.sh .
    sh pi/lsp/check/run.sh .
