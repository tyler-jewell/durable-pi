#!/bin/sh
# The agent eval: does a real model, given a coding task that never mentions language servers, use ours when it should?
# Each case runs in its own Apple container (a fresh Linux VM from the eval image) with DeepSeek Flash, and must finish
# inside BUDGET_MS. It scores the final repo (the gate must pass), the files, and whether the agent called an lsp_* tool.
#
#   sh pi/lsp/eval/run.sh <src-dir> [case...]          cases: ts-break vue-template signature (default: all)
#   REBUILD=1 forces the image to be rebuilt; CONTROL=none runs without the extension (every case must then fail); BUDGET_MS (default 20000) is the time each case may take.
set -eu
SRC="$(cd "${1:?usage: run.sh <src-dir> [case...]}" && pwd)"
shift
CASES="${*:-ts-break vue-template signature}"
IMAGE=dpi-lsp-eval:local
BUDGET_MS="${BUDGET_MS:-20000}"
now() { node -p 'Date.now()'; }

if [ "${REBUILD:-}" = 1 ] || ! container image ls 2>/dev/null | grep -q "dpi-lsp-eval"; then
  echo "eval: building $IMAGE (once; installs every pinned language server)"
  CTX="$(mktemp -d)"
  mkdir -p "$CTX/pi/lsp" "$CTX/pi/extensions/lsp"
  cp "$SRC/pi/lsp/install.sh" "$CTX/pi/lsp/"
  cp "$SRC/pi/extensions/lsp/core.mjs" "$SRC/pi/extensions/lsp/index.ts" "$CTX/pi/extensions/lsp/"
  cp "$SRC/pi/lsp/eval/Containerfile" "$CTX/Containerfile"
  container build -t "$IMAGE" -f "$CTX/Containerfile" "$CTX" >/dev/null
  container builder stop >/dev/null 2>&1 || true
  rm -rf "$CTX"
fi

# The key never goes on a command line: it is read from pi's auth file and sent through stdin.
KEY="$(node -p "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.pi/agent/auth.json', 'utf8')).deepseek.key")"
FAILS=0
for c in $CASES; do
  T0="$(now)"
  set +e
  OUT="$(printf '%s\n' "$KEY" | container run --rm -i --cpus 4 --memory 3G -e "CONTROL=${CONTROL:-}" -v "$SRC/pi:/src/pi:ro" "$IMAGE" sh /src/pi/lsp/eval/inside.sh "$c" 2>&1)"
  set -e
  MS=$(( $(now) - T0 ))
  echo "== $c"
  echo "$OUT" | grep -E "^(PASS|FAIL)" | sed 's/^/   /'
  RESULT="$(echo "$OUT" | grep '^EVAL_RESULT' | sed 's/^EVAL_RESULT //' || true)"
  if [ -z "$RESULT" ]; then echo "   NO RESULT:"; echo "$OUT" | tail -8 | sed 's/^/   | /'; FAILS=$((FAILS + 1)); continue; fi
  PASS="$(node -p "JSON.parse(process.argv[1]).pass" "$RESULT")"
  echo "   $(node -p "const r=JSON.parse(process.argv[1]); 'agent '+r.agentMs+' ms, setup '+r.setupMs+' ms, gate '+r.gateMs+' ms, '+r.turns+' turns, '+r.tokens+' tokens, \$'+r.costUsd+', tools: '+r.tools" "$RESULT")"
  if [ "$PASS" != true ]; then FAILS=$((FAILS + 1)); echo "   EVAL_FAIL $c"; continue; fi
  if [ "$MS" -gt "$BUDGET_MS" ]; then FAILS=$((FAILS + 1)); echo "   EVAL_SLOW $c: $MS ms (budget $BUDGET_MS ms)"; continue; fi
  echo "   EVAL_PASS $c in $MS ms"
done
if [ "$FAILS" = 0 ]; then
  echo "EVAL_ALL_PASS"
else
  echo "EVAL_FAILED: $FAILS case(s)"
  exit 1
fi
