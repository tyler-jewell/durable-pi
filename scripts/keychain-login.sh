#!/usr/bin/env bash
# One macOS Keychain generic-password item per login:
#   account  = email / username
#   password = JSON {"password": "...", "api_keys": {"<name>": "..."}}
#
#   keychain-login.sh save    <service> <email> [--key <name>]...      prompts (hidden) for password + each key
#   keychain-login.sh show    <service>                                 names and lengths only, never values
#   keychain-login.sh browser <service> <profile> <url> [--container <name>] [--login [--no-navigate]]
#   keychain-login.sh env     <service> <key-name> -- <command...>      exports the key as <KEY_NAME>_API_KEY
#
# Secrets never appear in argv or output: they move through stdin pipes, `security -i` with hex (-X),
# or the environment of the command being run. Only names, lengths and the account are printed.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# Read one secret: hidden prompt on a terminal, else one line from stdin (used by tests and automation).
read_secret() { # $1 = label; sets SECRET
  if [ -t 0 ]; then IFS= read -rs -p "$1: " SECRET </dev/tty; echo >&2
  else IFS= read -r SECRET || true; fi
  [ -n "$SECRET" ] || die "$1 is empty"
}

# JSON helpers run inside node; secrets arrive on stdin, names on argv.
item_json() { security find-generic-password -s "$1" -w 2>/dev/null; }
parse_or_die() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d)}catch{process.stderr.write("item is not in the expected format; re-run save\n");process.exit(3)}process.stdout.write(d)})'; }
account_of() { security find-generic-password -s "$1" 2>/dev/null | sed -n 's/.*"acct"<blob>="\(.*\)"$/\1/p'; }

cmd_save() {
  [ $# -ge 2 ] || usage
  local service=$1 email=$2; shift 2
  local names=()
  while [ $# -gt 0 ]; do
    case $1 in --key) names+=("$2"); shift 2 ;; *) usage ;; esac
  done
  read_secret "password for $email"; local password=$SECRET
  local values=("$password")
  for n in ${names[@]+"${names[@]}"}; do read_secret "API key '$n'"; values+=("$SECRET"); done
  unset SECRET

  # Build JSON from stdin lines (password first, then keys in --key order), names passed as argv.
  local json
  json=$(printf '%s\n' "${values[@]}" | node -e '
    const names = process.argv.slice(1);
    let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
      const lines = d.split("\n"); lines.pop();
      const out = { password: lines[0], api_keys: {} };
      names.forEach((n, i) => { out.api_keys[n] = lines[i + 1]; });
      process.stdout.write(JSON.stringify(out));
    });' ${names[@]+"${names[@]}"})
  unset values password

  # Hex keeps the secret out of argv; security -i reads the command from stdin.
  local hex
  hex=$(printf '%s' "$json" | xxd -p | tr -d '\n'); unset json
  printf 'add-generic-password -U -a %s -s %s -X %s\n' "$email" "$service" "$hex" | security -i >/dev/null
  unset hex
  echo "saved item '$service' for account '$email' (keys: ${names[*]:-none})"
}

cmd_show() {
  [ $# -eq 1 ] || usage
  local service=$1
  local account; account=$(account_of "$service"); [ -n "$account" ] || die "no item '$service'"
  item_json "$service" | parse_or_die | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j = JSON.parse(d);
      console.log("account:  " + process.argv[1]);
      console.log("password: " + (j.password ? j.password.length + " chars" : "MISSING"));
      const keys = Object.entries(j.api_keys || {});
      console.log("api keys: " + (keys.length ? keys.map(([n,v]) => n + " (" + v.length + " chars)").join(", ") : "none"));
    });' "$account"
}

# Headless Chromium inside the sandbox (root needs --no-sandbox). Never --headed: no display, no VNC.
BROWSER_ENV=(--env AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium --env 'AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage')

cmd_browser() {
  [ $# -ge 3 ] || usage
  local service=$1 profile=$2 url=$3; shift 3
  local container=browser-box login=0 navigate=1
  while [ $# -gt 0 ]; do
    case $1 in
      --container) container=$2; shift 2 ;;
      --login) login=1; shift ;;
      --no-navigate) navigate=0; shift ;;
      *) usage ;;
    esac
  done
  local account; account=$(account_of "$service"); [ -n "$account" ] || die "no item '$service'"

  # Password goes straight from the item to the sandbox's auth vault over stdin.
  item_json "$service" | parse_or_die | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).password));' \
    | container exec -i "${BROWSER_ENV[@]}" "$container" sh -c 'cd /root && agent-browser auth save "$1" --url "$2" --username "$3" --password-stdin' \
        _ "$profile" "$url" "$account" >/dev/null
  echo "saved profile '$profile' for account '$account' in $container"

  if [ "$login" = 1 ]; then
    local nav=""; [ "$navigate" = 1 ] || nav="--no-navigate"
    container exec "${BROWSER_ENV[@]}" "$container" sh -c "cd /root && agent-browser --session '$profile' auth login '$profile' $nav" >/dev/null
    echo "logged in with profile '$profile'"
  fi
}

cmd_env() {
  [ $# -ge 3 ] || usage
  local service=$1 key=$2; shift 2
  [ "$1" = "--" ] || usage; shift
  local var; var="$(printf '%s' "$key" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
  local value
  value=$(item_json "$service" | parse_or_die | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      const v = (JSON.parse(d).api_keys || {})[process.argv[1]];
      if (!v) { process.stderr.write("no API key named " + process.argv[1] + "\n"); process.exit(4); }
      process.stdout.write(v);
    });' "$key")
  export "$var=$value"; unset value
  exec "$@"
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case $cmd in
  save) cmd_save "$@" ;;
  show) cmd_show "$@" ;;
  browser) cmd_browser "$@" ;;
  env) cmd_env "$@" ;;
  *) usage ;;
esac
