#!/bin/sh
# Tests the git gate end to end: a temporary repo per case, commits through the real pre-commit path. Each case states
# what the gate must do. Run it wherever the gate is installed (this repo, a container, a device).
#
#   sh pi/lsp/gate-test.sh <src-dir>     src-dir holds pi/extensions/lsp (the repo root, or a copy)
set -u
SRC="${1:?usage: gate-test.sh <src-dir>}"
# Absolute: each case changes directory into its own temporary repo.
SRC="$(cd "$SRC" && pwd)" || exit 2
GATE="$SRC/pi/extensions/lsp/gate.mjs"
FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); }

# new_repo <name>: a fresh git repo with a tsconfig, so TypeScript has a project.
new_repo() {
  D="$(mktemp -d "${TMPDIR:-/tmp}/gate-$1.XXXX")"
  cd "$D" || exit 1
  git init -q -b main .
  git config user.email t@t.invalid && git config user.name gate-test
  printf '{"compilerOptions":{"strict":true,"noEmit":true,"target":"es2022","module":"esnext","moduleResolution":"bundler"},"include":["src"]}\n' > tsconfig.json
  mkdir -p src
  printf '{"name":"gate-test","private":true}\n' > package.json
  git add -A && git commit -q -m init --no-verify
}

# expect <case> <pass|fail> <needle-or-empty> [files...]: stage files, run the gate, check the outcome.
expect() {
  case_name="$1"; want="$2"; needle="$3"; shift 3
  git add -A >/dev/null 2>&1
  out=$(node "$GATE" staged 2>&1); code=$?
  if [ "$want" = pass ]; then
    if [ "$code" = 0 ]; then pass "$case_name"; else fail "$case_name" "expected pass, exit $code: $(echo "$out" | grep -m2 FAIL)"; fi
  else
    if [ "$code" = 1 ] && { [ -z "$needle" ] || echo "$out" | grep -q -- "$needle"; }; then
      pass "$case_name"
    else
      fail "$case_name" "expected fail${needle:+ matching $needle}, exit $code: $(echo "$out" | tail -3 | tr '\n' ' ')"
    fi
  fi
  git reset -q 2>/dev/null
  git stash list >/dev/null 2>&1
}

# 1. Clean, one file per language: must pass.
new_repo clean
printf 'export const n: number = 1;\n' > src/ok.ts
printf '{\n  "a": 1\n}\n' > data.json
printf 'a {\n  color: red;\n}\n' > site.css
printf '<!doctype html>\n<html lang="en"><head><title>t</title></head><body><p>x</p></body></html>\n' > page.html
# shellcheck disable=SC2016  # the file under test must contain a literal $HOME
printf '#!/bin/sh\nset -eu\necho "$HOME"\n' > run.sh
printf 'def f(x: int) -> int:\n    return x + 1\n' > tool.py
expect "clean: every language passes" pass "" src/ok.ts data.json site.css page.html run.sh tool.py
cd "$SRC" || exit 1; rm -rf "$D"

# 2. A TypeScript type error must block.
new_repo ts-error
printf 'export const label: string = 3;\n' > src/bad.ts
expect "typescript type error blocks" fail "error" src/bad.ts
cd "$SRC" || exit 1; rm -rf "$D"

# 3. A JSON syntax error must block.
new_repo json-error
printf '{ "a": 1 "b": 2 }\n' > data.json
expect "json syntax error blocks" fail "error" data.json
cd "$SRC" || exit 1; rm -rf "$D"

# 4. A CSS syntax error must block.
new_repo css-error
printf 'a { color red }\n' > site.css
expect "css syntax error blocks" fail "" site.css
cd "$SRC" || exit 1; rm -rf "$D"

# 5. A Python type error must block.
new_repo py-error
printf 'x: int = "not an int"\n' > tool.py
expect "python type error blocks" fail "error" tool.py
cd "$SRC" || exit 1; rm -rf "$D"

# 6. A Bash finding must block: ShellCheck reports an unquoted variable as information, and perfect means nothing flagged.
new_repo sh-warn
# shellcheck disable=SC2016  # the file under test must contain an unquoted $HOME
printf '#!/bin/sh\necho $HOME\n' > run.sh
expect "bash finding blocks" fail "information" run.sh
cd "$SRC" || exit 1; rm -rf "$D"

# 7. A signature change breaks a caller in a file that is NOT staged. The gate checks the whole project, so it must block.
new_repo cross-file
printf 'export function add(a: number, b: number): number { return a + b; }\n' > src/lib.ts
printf 'import { add } from "./lib";\nexport const v = add(1, 2);\n' > src/use.ts
git add -A && git commit -q -m base --no-verify
printf 'export function add(a: number, b: number, c: number): number { return a + b + c; }\n' > src/lib.ts
expect "breaking a caller in another file blocks" fail "error" src/lib.ts
cd "$SRC" || exit 1; rm -rf "$D"

# 8. A missing server must block (fail closed), never pass silently.
new_repo missing
printf 'export const n: number = 1;\n' > src/ok.ts
git add -A >/dev/null
out=$(DPI_LSP_TS_COMMAND=/nonexistent/typescript-language-server node "$GATE" staged 2>&1); code=$?
if [ "$code" = 1 ]; then pass "missing server blocks (fails closed)"; else fail "missing server blocks" "exit $code: $(echo "$out" | tail -2 | tr '\n' ' ')"; fi
cd "$SRC" || exit 1; rm -rf "$D"

echo
# 9. REGRESSION: a server that publishes an empty list first and the real list after a delay must block. Taking the first
#    list reads the file as clean. The fake server (gate-fixtures) does exactly that, so this fails on any gate that
#    does not wait for the settled list.
new_repo slow-semantic
printf 'export function twice(x) {\n  return x * 2;\n}\n' > src/loose.ts
export DPI_LSP_TS_COMMAND="$SRC/pi/lsp/gate-fixtures/slow-semantic-ls"
expect "a server that answers twice blocks on the second answer" fail "error" src/loose.ts
unset DPI_LSP_TS_COMMAND
cd "$SRC" || exit 1; rm -rf "$D"

# 9b. A strict-only error (implicit any) with the real server must block.
new_repo strict-only
printf 'export function twice(x) {\n  return x * 2;\n}\n' > src/loose.ts
expect "strict-only error (implicit any) blocks" fail "error" src/loose.ts
cd "$SRC" || exit 1; rm -rf "$D"

# 10. A server that dies must fail the gate, never pass it: a file no server answered is not clean. The server here is a
#     command that exits at once, so the check fails closed. The file itself is clean.
new_repo dead-server
printf 'export const n: number = 1;\n' > src/fine.ts
export DPI_LSP_TS_COMMAND=/usr/bin/false
expect "a server that exits blocks (fails closed)" fail "" src/fine.ts
unset DPI_LSP_TS_COMMAND
cd "$SRC" || exit 1; rm -rf "$D"

if [ "$FAILS" = 0 ]; then
  echo "GATE_TEST_PASS"
else
  echo "GATE_TEST_FAIL: $FAILS case(s)"
  exit 1
fi
