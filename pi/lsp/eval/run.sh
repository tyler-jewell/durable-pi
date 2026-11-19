#!/bin/sh
# The agent eval: a real model fixes four planted problems (TypeScript, JSON, CSS, Bash) and commits through the gate.
# It passes only if the final repo is clean, the commit went through, and the agent used the language servers.
#
#   sh pi/lsp/eval/run.sh <src-dir> [model]      src-dir holds pi/extensions/lsp and pi/lsp/eval (the repo root, or a copy)
set -eu
SRC="$(cd "${1:?usage: run.sh <src-dir> [model]}" && pwd)"
MODEL="${2:-deepseek-v4-flash}"
export EVAL_SRC="$SRC"
WORK="$HOME/.dpi/lsp-eval"
mkdir -p "$WORK"
sh "$SRC/pi/lsp/eval/fixture.sh" "$WORK/repo" >/dev/null
SESSION="$WORK/session"
rm -rf "$SESSION"
PROMPT='Four files in this repo have problems: src/math.ts (TypeScript), config.json (JSON), site.css (CSS), scripts/run.sh (Bash). Fix each so the project has no errors or warnings. Keep each file'"'"'s intent. Then commit everything with a message. Commits are checked by a gate: if it refuses, fix what it reports and commit again.'
cd "$WORK/repo"
set +e
pi --provider deepseek --model "$MODEL" -e "$SRC/pi/extensions/lsp/index.ts" --session-dir "$SESSION" -p "$PROMPT" > "$WORK/pi.out" 2>&1
PI_EXIT=$?
set -e
echo "pi exit $PI_EXIT"
cd "$SRC"
node "$SRC/pi/lsp/eval/assert.cjs" "$SESSION" "$WORK/repo"
