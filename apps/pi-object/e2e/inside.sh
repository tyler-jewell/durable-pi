#!/bin/sh
# Runs inside the e2e container. Stdin: line 1 = Artifacts remote, line 2 = repo token (never on argv).
set -eu
IFS= read -r ARTIFACTS_REMOTE
IFS= read -r ARTIFACTS_TOKEN
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $ARTIFACTS_TOKEN"

echo "PROFILE node=$(node -v) git=$(git --version | cut -d' ' -f3) wrangler=$(wrangler --version 2>/dev/null | tail -1) cf=$(cf --version 2>/dev/null | tail -1) pi=$(pi --version 2>/dev/null | tail -1) os=$(. /etc/os-release && echo "$PRETTY_NAME")"

mkdir -p /work && cd /work
git init -q -b main repo && cd repo
git remote add origin "$ARTIFACTS_REMOTE"
printf '# e2e repo\n' > README.md
git add README.md
git -c user.name=dpi-e2e -c user.email=e2e@dpi.invalid commit -q -m "e2e: seed"
git push -q origin HEAD:main
echo "SEED_SHA=$(git rev-parse HEAD)"

set +e
pi -ne -e /opt/e2e/faux-agent.ts --provider e2e-faux --model scripted --session-dir /work/session \
   -p "Create e2e/hello.txt, then commit and push it." </dev/null
AGENT_EXIT=$?
set -e
echo "AGENT_EXIT=$AGENT_EXIT"
echo "CONTAINER_HEAD=$(git rev-parse HEAD)"
echo "REMOTE_HEAD=$(git ls-remote origin refs/heads/main | cut -f1)"
exit "$AGENT_EXIT"
