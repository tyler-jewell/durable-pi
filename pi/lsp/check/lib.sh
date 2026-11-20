# Shared by run.sh and reload.sh (sourced). prepare <src> <work> copies the check's files to <work>, installs its
# dependencies, and leaves PI_CODING_AGENT_DIR, PATH and DPI_LSP_CHECK_DIR set for a session that uses only <work>.
prepare() {
  SRC="$1"; WORK="$2"
  rm -rf "$WORK" && mkdir -p "$WORK"
  cp -R "$SRC/pi/lsp/check/." "$WORK/"
  (cd "$WORK" && npm install --no-audit --no-fund >/dev/null 2>&1)
  export PI_CODING_AGENT_DIR="$WORK/agent"
  export PATH="$HOME/.dpi/lsp-tools/node_modules/.bin:$PATH"
  export DPI_LSP_CHECK_DIR="$WORK"
}

# install_extension <src-dir>: installs the extension from <src-dir> (with the repo's installer) into the isolated agent
# folder, and prints its build id.
install_extension() {
  sh "$SRC/pi/lsp/install.sh" "$1" > "$WORK/install.out" 2>&1 || { cat "$WORK/install.out"; return 1; }
  cat "$PI_CODING_AGENT_DIR/extensions/lsp/BUILD"
}

# fixture <dir>: a fresh copy of the check's fixture project at <dir>. The Vue server type-checks templates against the
# project's own vue, so the pinned copy is linked in, as a project install would.
fixture() {
  rm -rf "$1" && cp -R "$SRC/pi/lsp/check/fixture" "$1"
  mkdir -p "$1/node_modules" && ln -sfn "$HOME/.dpi/lsp-tools/node_modules/vue" "$1/node_modules/vue"
  (cd "$1" && git init -q && git add -- . ':!node_modules')
}
