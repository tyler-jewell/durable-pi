#!/bin/sh
# The project's copy of the extension (.pi/extensions/lsp, which is version controlled) must be exactly what install.sh
# makes from the source. Installs into a scratch folder and compares. A copy that drifts is a bug nobody sees.
#
#   sh pi/lsp/check/tracked.sh <src-dir>     src-dir holds pi/ and .pi/ (the repo root)
set -eu
SRC="$(cd "${1:?usage: tracked.sh <src-dir>}" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/lsp-tracked.XXXX")"
trap 'rm -rf "$OUT"' EXIT
LSP_EXTENSION_DIR="$OUT" sh "$SRC/pi/lsp/install.sh" "$SRC" >/dev/null 2>&1
if diff -r "$OUT" "$SRC/.pi/extensions/lsp" >/dev/null 2>&1; then
  echo "LSP_TRACKED_PASS (.pi/extensions/lsp is what install.sh makes from the source)"
else
  echo "LSP_TRACKED_FAIL: .pi/extensions/lsp differs from the source. Run 'just lsp install' and commit the result."
  exit 1
fi
