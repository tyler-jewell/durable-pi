# The llama.cpp server for this host and the mesh: render, check, compare and apply llama/config.yaml.

set shell := ["zsh", "-cu"]
set positional-arguments

# List llama commands
[default]
[no-cd]
default:
    @just --list llama

# Print the launch agent that a host runs (host names come from llama/hosts.yaml)
[no-cd]
render HOST:
    @cd scripts && npx tsx llama.mts render "$1"

# Print the server command line for a host, one argument per line
[no-cd]
argv HOST:
    @cd scripts && npx tsx llama.mts argv "$1"

# Validate llama/config.yaml and this machine's hosts, and check every flag against the local llama-server
[no-cd]
check:
    @cd scripts && npx tsx llama.mts check

# Compare a running server's arguments (its /v1/models) with the config. Set DPI_LLAMA_ACCESS_ENV for a host behind Access.
[no-cd]
drift HOST URL:
    @cd scripts && npx tsx llama.mts drift "$1" "$2"

# Write this machine's launch agent, unload what it replaces, and start it (macOS, run on the host itself)
[no-cd]
apply HOST:
    @cd scripts && npx tsx llama.mts apply "$1"

# Unit tests for the config, the command line, the launch agent and drift
[no-cd]
test:
    cd scripts && npx tsx --test llama.test.mts
