#!/bin/sh
# The deterministic LSP check, on this machine or a device: pi's real CLI, a scripted model, and the extension installed
# from THIS source into an isolated agent folder (so it tests the repo, not whatever is installed globally). It proves:
# the files decide the servers, one server per language, every strategy answers (tsserver, pull, publish), an edit is
# re-checked, the git gate cannot be bypassed, and no server is left behind when the session ends.
#
#   sh pi/lsp/check/run.sh <src-dir>     src-dir holds pi/ (the repo root, or a copy)
set -eu
SRC="$(cd "${1:?usage: run.sh <src-dir>}" && pwd)"
. "$SRC/pi/lsp/check/lib.sh"
prepare "$SRC" "$HOME/.dpi/lsp-check"
BUILD="$(install_extension "$SRC")"
fixture "$WORK/fixture"
cd "$WORK/fixture"
git init -q
printf 'ignored.sh\nnode_modules/\n' > .gitignore
printf '#!/bin/bash\necho ok\n' > "$WORK/outside.sh"
cp "$WORK/outside.sh" ignored.sh
cp "$WORK/outside.sh" node_modules/generated.sh
ln -s "$WORK/outside.sh" outside-link.sh
set +e
pi --provider lsp-faux --model scripted -e "$WORK/lsp-faux.ts" --session-dir "$WORK/session" \
  -p "Check the project types, then report." >"$WORK/pi.out" 2>&1
PI_EXIT=$?
set -e
node "$WORK/assert.cjs" "$WORK/session" "$WORK/pi.out" "$BUILD" || { echo "LSP_CHECK_FAIL (pi exit $PI_EXIT)"; exit 1; }
[ "$PI_EXIT" = 0 ] || { echo "LSP_CHECK_FAIL: pi exited $PI_EXIT"; exit 1; }
# Nothing may outlive the session. The pids come from the probe; kill -0 asks whether each still exists (works on macOS and Linux).
sleep 2
PIDS="$(grep -ho 'RUNNING [a-z-]* pid=[0-9]*' "$WORK"/session/*.jsonl | sed 's/.*pid=//' | sort -u)"
[ -n "$PIDS" ] || { echo "LSP_CHECK_FAIL: the probe saw no servers"; exit 1; }
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then echo "LSP_CHECK_FAIL: server $pid still running after the session"; exit 1; fi
done
echo "LSP_CHECK_PASS ($(echo "$PIDS" | wc -w | tr -d ' ') servers, all gone after the session)"
