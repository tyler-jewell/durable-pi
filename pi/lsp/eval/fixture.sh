#!/bin/sh
# Creates the eval repo at $1: four files, one planted problem per language, the gate installed as the pre-commit hook.
set -eu
DIR="$1"
rm -rf "$DIR" && mkdir -p "$DIR/src" "$DIR/scripts" "$DIR/pi/extensions/lsp" "$DIR/.githooks"
cd "$DIR"
git init -q -b main . && git config user.email eval@dpi.invalid && git config user.name eval
printf '{"compilerOptions":{"strict":true,"noEmit":true,"target":"es2022","module":"esnext","moduleResolution":"bundler"},"include":["src"]}\n' > tsconfig.json
printf '{"name":"eval-repo","private":true,"type":"module"}\n' > package.json
# TypeScript: a number is returned where a string is declared.
printf 'export function total(xs: number[]): string {\n  return xs.reduce((a, b) => a + b, 0);\n}\n' > src/math.ts
# JSON: a missing comma between members.
printf '{\n  "name": "eval",\n  "retries": 3\n  "verbose": true\n}\n' > config.json
# CSS: a declaration without a colon.
printf 'body {\n  margin 0;\n}\n' > site.css
# Bash: an unquoted variable.
# shellcheck disable=SC2016  # the planted file must contain literal shell text, $NAME unexpanded
printf '#!/bin/sh\nset -eu\nNAME="world"\necho Hello $NAME\n' > scripts/run.sh
chmod +x scripts/run.sh
# The gate: the same files the repo uses.
cp "$EVAL_SRC/pi/extensions/lsp/gate.mjs" "$EVAL_SRC/pi/extensions/lsp/core.mjs" pi/extensions/lsp/
# shellcheck disable=SC2016  # the hook must contain literal shell text, expanded when git runs it
printf '#!/bin/sh\nset -eu\nexec node "$(git rev-parse --show-toplevel)/pi/extensions/lsp/gate.mjs" staged\n' > .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
git add -A && git commit -q -m "eval: start" --no-verify
echo "fixture ready at $DIR"
