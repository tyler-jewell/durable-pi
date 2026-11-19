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

# The file extensions in this repo, and the servers they call for (starts nothing)
[no-cd]
plan:
    node pi/extensions/lsp/gate.mjs plan

# Every file of every language must be clean by the servers' standard, across the whole repo
[no-cd]
check:
    node pi/extensions/lsp/gate.mjs all

# Test the gate, the extension in a real pi session (a scripted model), and /reload. No network, no model.
[no-cd]
test:
    sh pi/lsp/gate-test.sh .
    sh pi/lsp/check/run.sh .
    sh pi/lsp/check/reload.sh .

# Agent eval: DeepSeek Flash, three coding tasks that never mention language servers, each in its own Apple container.
# Does the agent reach for ours? Needs the container system and a DeepSeek key in ~/.pi/agent/auth.json.
[no-cd]
eval *cases:
    sh pi/lsp/eval/run.sh . {{cases}}
