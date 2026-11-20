#!/bin/sh
# Run the Artifacts e2e inside one container. The Cloudflare token is read from the Keychain into a
# mounted file. It is not passed as an environment variable.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ACCOUNT="$(awk -F= '/^CLOUDFLARE_ACCOUNT_ID=/{print substr($0, index($0,"=")+1)}' "$ROOT/.env" | tr -d '"')"
[ -n "$ACCOUNT" ] || { echo "CLOUDFLARE_ACCOUNT_ID is missing"; exit 1; }
STAGE="$(mktemp -d)"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
security find-generic-password -s durable-pi.cloudflare -a durable-admin -w | tr -d '\n' > "$STAGE/cloudflare"
printf '\n%s\n' "$ACCOUNT" >> "$STAGE/cloudflare"
chmod 600 "$STAGE/cloudflare"
cp "$ROOT/apps/pi-object/e2e/container-main.mjs" "$STAGE/container-main.mjs"
RUN_ID="e2e-isolated-$(date +%s | xargs printf '%x')-$$"
container run --rm --init --cpus 2 --memory 1G --name "$RUN_ID" \
  --mount "type=bind,source=$STAGE,target=/run/secrets,readonly" \
  dpi-artifacts-dev:local node /run/secrets/container-main.mjs "$RUN_ID"
