#!/usr/bin/env bash
# End-to-end proof for the PiAgent Durable Object, run under workerd via `wrangler dev`:
#   1. the agent writes and reads a file through its tools, using Anthropic (haiku-5-5)
#   2. the file is still there after the dev server restarts (the DO storage is durable)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8788}
BASE="http://127.0.0.1:$PORT"
FILE=/workspace/haiku.txt
LOG=$(mktemp)

start() {
  npx wrangler dev --port "$PORT" >"$LOG" 2>&1 &
  echo $! >"$LOG.pid"
  for _ in $(seq 1 90); do curl -s -o /dev/null "$BASE/" && return 0; sleep 1; done
  echo "dev server did not start"; cat "$LOG"; exit 1
}
stop() { kill "$(cat "$LOG.pid")" 2>/dev/null || true; wait "$(cat "$LOG.pid")" 2>/dev/null || true; }
trap stop EXIT

start
RESULT=$(curl -s -X POST "$BASE/" -H 'content-type: application/json' \
  -d '{"task":"Write a haiku about durable objects to /workspace/haiku.txt, then read it back and tell me what you wrote."}')
echo "run:    $RESULT"
node -e 'const r=JSON.parse(process.argv[1]); if (r.toolCalls < 2) { console.error("FAIL: expected at least 2 tool calls"); process.exit(1) }' "$RESULT"
BEFORE=$(curl -s "$BASE/file?path=$FILE")
[ -n "$BEFORE" ] || { echo "FAIL: $FILE is empty after the run"; exit 1; }
echo "before: $(echo "$BEFORE" | head -1) ..."

stop
start
AFTER=$(curl -s "$BASE/file?path=$FILE")
if [ "$BEFORE" != "$AFTER" ]; then echo "FAIL: file changed across restart"; exit 1; fi
echo "after restart: identical ($(echo "$AFTER" | wc -l | tr -d ' ') lines)"
echo "PASS: DO agent wrote, read back and kept the file across a restart"
