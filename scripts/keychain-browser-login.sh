#!/usr/bin/env bash
# Hand a password from the macOS Keychain to a browser sandbox without ever printing or passing it as an argument.
#
#   scripts/keychain-browser-login.sh <keychain-service> <profile> <login-url> [--container <name>] [--login [--no-navigate]]
#
# The password flows Keychain -> stdin of `container exec` -> `agent-browser auth save --password-stdin`, which
# keeps it in the sandbox's encrypted auth vault. It never reaches argv, the environment, logs or this script's
# output. Only the account name (not a secret) is printed.
#
# Save it once with:  security add-generic-password -a "<account>" -s "<service>" -U -w   (prompts, hidden)
set -euo pipefail

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 3 ] || usage

SERVICE=$1; PROFILE=$2; URL=$3; shift 3
CONTAINER=browser-box; LOGIN=0; NAVIGATE=1; SESSION=$PROFILE
while [ $# -gt 0 ]; do
  case $1 in
    --container) CONTAINER=$2; shift 2 ;;
    --login) LOGIN=1; shift ;;
    --no-navigate) NAVIGATE=0; shift ;;
    *) usage ;;
  esac
done

# The account is metadata, not the secret. The value is read only inside the pipeline below.
ACCOUNT=$(security find-generic-password -s "$SERVICE" 2>/dev/null | sed -n 's/.*"acct"<blob>="\(.*\)"$/\1/p')
[ -n "$ACCOUNT" ] || { echo "no Keychain item for service '$SERVICE' (save it with security add-generic-password)" >&2; exit 1; }

security find-generic-password -s "$SERVICE" -w 2>/dev/null \
  | container exec -i "$CONTAINER" sh -c 'cd /root && agent-browser auth save "$1" --url "$2" --username "$3" --password-stdin' \
      _ "$PROFILE" "$URL" "$ACCOUNT" >/dev/null
echo "saved profile '$PROFILE' for account '$ACCOUNT' in $CONTAINER"

if [ "$LOGIN" = 1 ]; then
  if [ "$NAVIGATE" = 1 ]; then NAV=""; else NAV="--no-navigate"; fi
  container exec "$CONTAINER" sh -c "cd /root && agent-browser --session '$SESSION' auth login '$PROFILE' $NAV" >/dev/null
  echo "logged in with profile '$PROFILE'"
fi
