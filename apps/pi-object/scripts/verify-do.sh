#!/usr/bin/env bash
# End-to-end proof for the PiAgent Durable Object, run under workerd via `wrangler dev`:
#   1. the agent writes and reads a file through its tools, using DeepSeek (deepseek-flash)
#   2. the telemetry matches the run: pi token counts, tool calls and wall time reach GET /v1/cost
#   3. the file is still there after the dev server restarts (the DO storage is durable)
set -euo pipefail
cd "$(dirname "$0")/.."
# The Worker requires DPI_TOKEN (see .dev.vars.example); export it or keep it in .dev.vars.
DPI_TOKEN=${DPI_TOKEN:-$(sed -n "s/^DPI_TOKEN=//p" .dev.vars)}
PORT=${PORT:-8788}
BASE="http://127.0.0.1:$PORT"
FILE=/workspace/haiku.txt
LOG=$(mktemp)

start() {
  if curl -s -o /dev/null --max-time 2 "$BASE/"; then echo "FAIL: port $PORT is already in use; stop the other dev server first"; exit 1; fi
  # Own process group, so stop() can take down wrangler and its workerd child together.
  set -m
  npx wrangler dev --port "$PORT" >"$LOG" 2>&1 &
  PGID=$!
  set +m
  echo $PGID >"$LOG.pid"
  for _ in $(seq 1 90); do curl -s -o /dev/null "$BASE/" && return 0; sleep 1; done
  echo "dev server did not start"; cat "$LOG"; exit 1
}
stop() {
  local pgid; pgid=$(cat "$LOG.pid" 2>/dev/null) || return 0
  kill -- -$pgid 2>/dev/null || true
  for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 1 "$BASE/" || return 0; sleep 1; done
  echo "port $PORT did not free after stop"; exit 1
}
trap stop EXIT

start
RESULT=$(curl -s --max-time 240 -X POST "$BASE/" -H "authorization: Bearer $DPI_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Write a haiku about durable objects to /workspace/haiku.txt, then read it back and tell me what you wrote."}')
if [ -z "$RESULT" ]; then echo "FAIL: run request failed or timed out"; tail -40 "$LOG"; exit 1; fi
echo "run:    $RESULT"
COST=$(curl -s --max-time 30 -H "authorization: Bearer $DPI_TOKEN" "$BASE/v1/cost")
node -e '
  const c = JSON.parse(process.argv[1]); const rows = Object.fromEntries(c.usage.rows.map((r) => [r.sku, r.quantity]));
  const llmOut = Object.entries(rows).filter(([k]) => k.endsWith(".output")).reduce((n, [, q]) => n + q, 0);
  const checks = {
    "pi tokens recorded": llmOut > 0 && Object.keys(rows).some((k) => k.endsWith(".input_miss") || k.endsWith(".input_hit")),
    "tool calls counted": Object.entries(rows).filter(([k]) => k.startsWith("tools.") && k.endsWith(".calls")).reduce((n, [, q]) => n + q, 0) >= 2,
    "LLM wall time measured": Object.entries(rows).some(([k, q]) => k.endsWith(".wall_ms") && k.startsWith("llm.") && q > 0),
    "deepseek cost object present": c.objects.some((o) => o.id === "deepseek"),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) { console.error("FAIL: telemetry: " + failed.join(", ")); process.exit(1) }
  console.log("cost: deepseek object " + c.objects[0].status + (c.objects[0].note ? " (" + c.objects[0].note + ")" : "") + "; telemetry checks ok");
' "$COST"
node -e 'const r=JSON.parse(process.argv[1]); if (r.toolCalls < 2) { console.error("FAIL: expected at least 2 tool calls"); process.exit(1) }' "$RESULT"
BEFORE=$(curl -s --max-time 20 -H "authorization: Bearer $DPI_TOKEN" "$BASE/file?path=$FILE")
[ -n "$BEFORE" ] || { echo "FAIL: $FILE is empty after the run"; exit 1; }
echo "before: $(echo "$BEFORE" | head -1) ..."

stop
start
AFTER=$(curl -s --max-time 20 -H "authorization: Bearer $DPI_TOKEN" "$BASE/file?path=$FILE")
if [ "$BEFORE" != "$AFTER" ]; then echo "FAIL: file changed across restart"; exit 1; fi
echo "after restart: identical ($(echo "$AFTER" | wc -l | tr -d ' ') lines)"
echo "PASS: DO agent wrote, read back and kept the file across a restart"
