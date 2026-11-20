#!/bin/sh
# The custom-message check: a run started by pi.sendMessage(..., { triggerTurn: true }) while idle has no prompt, and
# before_agent_start must still give it the language-servers section. A scripted model reports the section it was given.
#
#   sh pi/lsp/check/trigger.sh <src-dir>
set -eu
SRC="$(cd "${1:?usage: trigger.sh <src-dir>}" && pwd)"
. "$SRC/pi/lsp/check/lib.sh"
prepare "$SRC" "$HOME/.dpi/lsp-trigger"
BUILD="$(install_extension "$SRC")"
fixture "$WORK/fixture"
cd "$WORK/fixture"
set +e
pi --provider lsp-trigger --model scripted -e "$WORK/trigger-faux.ts" --session-dir "$WORK/session" \
  -p "Check the project types." >"$WORK/pi.out" 2>&1
PI_EXIT=$?
set -e
node "$WORK/trigger-assert.cjs" "$WORK/session" || { echo "TRIGGER_FAIL (pi exit $PI_EXIT)"; cat "$WORK/pi.out" | tail -20; exit 1; }
echo "TRIGGER_PASS (build $BUILD)"
