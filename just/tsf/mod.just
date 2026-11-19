# The .tsf software factory: stamp the roster + prompts into a repo.
set shell := ["zsh", "-cu"]
set positional-arguments

# List tsf recipes
[default]
default:
    @just --list tsf

# Stamp .tsf/ into a directory (default: current dir). Idempotent.
[no-cd]
install *DIR:
    @npx --yes tsx@4.22.0 scripts/tsf-install.mts {{DIR}}
