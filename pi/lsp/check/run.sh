#!/bin/sh
# The deterministic LSP check, on this machine or a device: pi's real CLI, a scripted model, the LSP extension loaded from
# pi's global extensions folder. It proves the language server starts with the session, answers diagnostics, definition
# and hover with real results, and is gone when the session ends.
#
#   sh pi/lsp/check/run.sh <src-dir>     src-dir holds pi/lsp/check (the repo root, or a copy)
set -eu
SRC="${1:?usage: run.sh <src-dir>}"
WORK="$HOME/.dpi/lsp-check"
rm -rf "$WORK" && mkdir -p "$WORK"
cp -R "$SRC/pi/lsp/check/." "$WORK/"
(cd "$WORK" && npm install --no-audit --no-fund >/dev/null 2>&1)
export PATH="$HOME/.dpi/lsp-tools/node_modules/.bin:$PATH"
export DPI_LSP_CHECK_DIR="$WORK"
cd "$WORK/fixture"
rm -rf "$WORK/session"
set +e
pi --provider lsp-faux --model scripted -e "$WORK/lsp-faux.ts" --session-dir "$WORK/session" \
  -p "Check the project types, then report." >"$WORK/pi.out" 2>&1
PI_EXIT=$?
set -e
PID=$(grep -o 'pid [0-9]*' "$WORK/pi.out" | head -1 | cut -d' ' -f2 || true)
node "$WORK/assert.cjs" "$WORK/session" || { echo "LSP_CHECK_FAIL (pi exit $PI_EXIT)"; exit 1; }
[ "$PI_EXIT" = 0 ] || { echo "LSP_CHECK_FAIL: pi exited $PI_EXIT"; exit 1; }
sleep 2
if [ -n "$PID" ] && [ -d "/proc/$PID" ]; then echo "LSP_CHECK_FAIL: server $PID still running after the session"; exit 1; fi
echo "LSP_CHECK_PASS (server $PID gone after the session)"
