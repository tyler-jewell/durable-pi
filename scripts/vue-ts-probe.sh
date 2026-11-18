#!/usr/bin/env bash
# Re-runs the TypeScript check (default 7.0.2; TS_VERSION=5.9.3 is the control) for the Vue apps for the Vue apps inside a clean Node 26 container, on the committed tree.
#
#   scripts/ts7-probe.sh                                  # base-app and the playground front end
#   scripts/ts7-probe.sh apps/base-app:.                  # one app: <app dir>:<vue-tsc project>
#
# Exit 0 means that app's type check (vue-tsc) runs on TypeScript 7 today. Exit 1 means it does not. Nothing is written
# to the repo: the tree is exported to a temp directory, which is removed on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="docker.io/library/node:26-bookworm-slim"
TS_VERSION="${TS_VERSION:-7.0.2}"
TARGETS=("$@")
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=("apps/base-app:." "apps/dpi-playground:apps/dpi-playground-fe/tsconfig.json")
command -v container >/dev/null || { echo "Apple container CLI not found" >&2; exit 2; }

W=$(mktemp -d "${TMPDIR:-/tmp}/ts7-probe.XXXX")
trap 'rm -rf "$W"' EXIT
git archive HEAD apps | tar -x -C "$W"

cat > "$W/probe.sh" <<'INNER'
set -u
fail=0
for target in "$@"; do
  app="${target%%:*}"; project="${target#*:}"
  echo "=== $app (vue-tsc -p $project) ==="
  cd "/probe/$app"
  node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.devDependencies=p.devDependencies||{};p.devDependencies.typescript=process.env.TS_VERSION;fs.writeFileSync("package.json",JSON.stringify(p,null,2))'
  if ! npm install --no-audit --no-fund >/tmp/install.log 2>&1; then echo "install FAILED"; tail -5 /tmp/install.log; fail=1; continue; fi
  echo "typescript: $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("node_modules/typescript/package.json","utf8")).version)')"
  if npx vue-tsc --noEmit -p "$project" >/tmp/vuetsc.log 2>&1; then
    echo "RESULT: pass"
  else
    code=$?; echo "RESULT: fail (exit $code)"; grep -m3 -E "ERR_|error" /tmp/vuetsc.log | cut -c1-200; fail=1
  fi
  cd /probe
done
exit $fail
INNER

# The probe runs in /probe, which holds the exported apps and the probe script.
set +e
container run --rm --init --cpus 4 --memory 4G --mount "type=bind,source=$W,target=/probe" -e "TS_VERSION=$TS_VERSION" "$IMAGE" sh /probe/probe.sh "${TARGETS[@]}"
status=$?
set -e
echo
if [ $status -eq 0 ]; then echo "ts-probe: every Vue app type-checks on TypeScript $TS_VERSION"; else echo "ts-probe: vue-tsc does not run on TypeScript $TS_VERSION for these apps (exit $status)"; fi
exit $status
