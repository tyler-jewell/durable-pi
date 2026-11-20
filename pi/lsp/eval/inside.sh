#!/bin/sh
# Runs inside the eval container, for one case. Stdin, line 1: the DeepSeek key (never on a command line).
# Sets up the case's repo, installs the extension from the mounted source, gives a real model the task (the task never
# mentions language servers), and scores what the agent did.
set -eu
CASE="${1:?usage: inside.sh <case>}"
SRC=/src
IFS= read -r DEEPSEEK_API_KEY
export DEEPSEEK_API_KEY
now() { date +%s%3N; }
T0="$(now)"
export PI_CODING_AGENT_DIR=/root/agent
# CONTROL=none leaves the extension out, so the agent has no language server tools: the eval must then fail.
[ "${CONTROL:-}" = none ] || LSP_EXTENSION_DIR=/root/agent/extensions/lsp sh "$SRC/pi/lsp/install.sh" "$SRC" >/dev/null 2>&1
CASE_DIR="$SRC/pi/lsp/eval/cases/$CASE"
REPO=/work/repo
rm -rf /work && mkdir -p "$REPO" && cp -R "$CASE_DIR/repo/." "$REPO/"
cd "$REPO"
if grep -q '"vue": true' "$CASE_DIR/case.json"; then
  mkdir -p node_modules && ln -s /root/.dpi/lsp-tools/node_modules/vue node_modules/vue
fi
printf 'node_modules/\n' > .gitignore
git init -q -b main . && git add -A && git -c user.name=eval -c user.email=eval@dpi.invalid commit -q -m start
T1="$(now)"
set +e
timeout 90 pi --provider deepseek --model deepseek-flash --thinking off \
  --no-skills --no-context-files --no-prompt-templates --no-mcp --no-themes \
  --session-dir /work/session -p "$(cat "$CASE_DIR/prompt.txt")" </dev/null > /work/pi.out 2>&1
PI_EXIT=$?
set -e
T2="$(now)"
node "$SRC/pi/lsp/eval/score.cjs" /work/session "$CASE_DIR/case.json" "$REPO" "$SRC/pi/extensions/lsp/gate.mjs" "$PI_EXIT" "$((T1 - T0))" "$((T2 - T1))"
