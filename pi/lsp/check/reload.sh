#!/bin/sh
# The /reload check: a changed extension (a changed core.mjs, as in a real update) is installed while a Pi session runs,
# the session reloads, and the tools must run the new build. It runs twice. With the layout install.sh produces the
# reload must pick up the new build. With the old layout (core.mjs under a fixed name) it must NOT: that is the failure
# this check exists for, and seeing it fail there proves the check can tell the two apart.
#
#   sh pi/lsp/check/reload.sh <src-dir>
set -eu
SRC="$(cd "${1:?usage: reload.sh <src-dir>}" && pwd)"
. "$SRC/pi/lsp/check/lib.sh"
prepare "$SRC" "$HOME/.dpi/lsp-reload"

# Build B: the same source with core.mjs changed, so its content hash differs.
B="$WORK/srcB"
mkdir -p "$B/pi/extensions/lsp"
cp "$SRC/pi/extensions/lsp/core.mjs" "$SRC/pi/extensions/lsp/index.ts" "$B/pi/extensions/lsp/"
printf '\n// build B of the reload check\n' >> "$B/pi/extensions/lsp/core.mjs"

# The old layout: core.mjs under a fixed name, index.ts importing it by that name.
cat > "$WORK/plain-install.sh" <<'PLAIN'
set -eu
EXT="$PI_CODING_AGENT_DIR/extensions/lsp"
rm -rf "$EXT" && mkdir -p "$EXT"
sed "s#LSP_BUILD = \"dev\"#LSP_BUILD = \"$2\"#" "$1/pi/extensions/lsp/core.mjs" > "$EXT/core.mjs"
cp "$1/pi/extensions/lsp/index.ts" "$EXT/index.ts"
PLAIN

# run <mode>: installs build A, runs a session that swaps in build B and reloads, then scores it.
run() {
  mode="$1"
  if [ "$mode" = hashed ]; then
    BEFORE="$(install_extension "$SRC")"
    AFTER="$(install_extension "$B")"
    install_extension "$SRC" >/dev/null                      # back to A for the run
    printf 'sh "%s/pi/lsp/install.sh" "%s" >/dev/null 2>&1\n' "$SRC" "$B" > "$WORK/swap.sh"
  else
    BEFORE=plainA AFTER=plainB
    sh "$WORK/plain-install.sh" "$SRC" "$BEFORE"
    printf 'sh "%s/plain-install.sh" "%s" "%s"\n' "$WORK" "$B" "$AFTER" > "$WORK/swap.sh"
  fi
  export DPI_RELOAD_SWAP="$WORK/swap.sh"
  fixture "$WORK/fixture"
  rm -rf "$WORK/session-$mode"
  set +e
  (cd "$WORK/fixture" && pi --provider reload-faux --model scripted -e "$WORK/reload-faux.ts" --session-dir "$WORK/session-$mode" \
    -p "Check the project types." "Now check them again." >"$WORK/pi-$mode.out" 2>&1)
  set -e
  node "$WORK/reload-assert.cjs" "$WORK/session-$mode" "$BEFORE" "$AFTER"
}

echo "== installed layout (core.<hash>.mjs): the reload must run the new build"
if run hashed; then echo "RELOAD_PASS"; else echo "RELOAD_FAIL"; exit 1; fi
echo "== old layout (core.mjs): the reload is expected to keep the old build, which this check must report"
if run plain >"$WORK/control.out" 2>&1; then
  cat "$WORK/control.out"; echo "RELOAD_CONTROL_FAIL: the old layout passed, so this check cannot tell the layouts apart"; exit 1
fi
grep FAIL "$WORK/control.out" | head -2
echo "RELOAD_CONTROL_OK (the old layout is caught)"
