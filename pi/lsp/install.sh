#!/bin/sh
# Installs the language servers, pi, and the LSP extension, on this machine or a device. Idempotent: running it again
# changes nothing that is already right. Everything goes to a dedicated prefix (~/.dpi/lsp-tools), so a global `tsc`
# or `python` that other projects use is never replaced. The extension is copied to <src-dir>/.pi/extensions/lsp, which
# is version controlled, so pi loads it for that project only (LSP_EXTENSION_DIR moves it: the tests and the eval do).
#
#   sh pi/lsp/install.sh <src-dir>     src-dir holds pi/extensions/lsp and pi/lsp (the repo root, or a copy of them)
#
# Needs: node and npm (any version the servers accept), python3 (for Python), shellcheck (for Bash diagnostics).
set -eu
SRC="${1:?usage: install.sh <src-dir>}"
[ -d "$SRC/pi/extensions/lsp" ] || { echo "install: no $SRC/pi/extensions/lsp" >&2; exit 2; }
TOOLS="$HOME/.dpi/lsp-tools"
mkdir -p "$TOOLS"
# Pinned: each server, the TypeScript that the TypeScript server reads (5.9.3), and pi.
PINS='typescript@5.9.3 typescript-language-server@6.1.0 vscode-langservers-extracted@4.10.0 bash-language-server@5.8.1 pyright@1.1.414 @vue/language-server@3.3.14 vue@3.5.43 @earendil-works/pi-coding-agent@1.5.2'
want_ok=1
for pin in $PINS; do
  name="${pin%@*}"; ver="${pin##*@}"
  grep -q "\"$name\": \"$ver\"" "$TOOLS/package.json" 2>/dev/null || want_ok=0
done
if [ "$want_ok" = 0 ]; then
  # shellcheck disable=SC2086
  (cd "$TOOLS" && { [ -f package.json ] || echo '{"name":"dpi-lsp-tools","private":true}' > package.json; } && npm install --no-audit --no-fund --save-exact $PINS >/dev/null)
fi
for need in python3 shellcheck; do
  command -v "$need" >/dev/null 2>&1 || echo "lsp: warning: $need is not on PATH (needed for $( [ $need = python3 ] && echo Python || echo Bash ) diagnostics)" >&2
done
# The extension goes to the project's .pi/extensions/lsp (LSP_EXTENSION_DIR moves it: the tests install in isolation).
# core.mjs is installed under a name that carries its content hash, and index.ts is pointed at that name. Pi caches a
# module by path for the life of the process, so a /reload that finds core.mjs again would run the old one under the new
# index.ts. A new hash is a new path, so a reload always runs what was installed. The hash is the build id, kept in $EXT/BUILD.
SRC="$(cd "$SRC" && pwd)"
EXT="${LSP_EXTENSION_DIR:-$SRC/.pi/extensions/lsp}"
HASH="$(node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('$SRC/pi/extensions/lsp/core.mjs')).digest('hex').slice(0, 12)")"
rm -rf "$EXT" && mkdir -p "$EXT"
sed "s#LSP_BUILD = \"dev\"#LSP_BUILD = \"$HASH\"#" "$SRC/pi/extensions/lsp/core.mjs" > "$EXT/core.$HASH.mjs"
sed "s#\"./core.mjs\"#\"./core.$HASH.mjs\"#" "$SRC/pi/extensions/lsp/index.ts" > "$EXT/index.ts"
printf '%s\n' "$HASH" > "$EXT/BUILD"
echo "lsp: installed to $TOOLS and $EXT (build $HASH)"
echo "lsp: typescript-language-server $("$TOOLS/node_modules/.bin/typescript-language-server" --version 2>/dev/null | head -1), typescript $(node -p "require('$TOOLS/node_modules/typescript/package.json').version"), pyright $(node -p "require('$TOOLS/node_modules/pyright/package.json').version")"
