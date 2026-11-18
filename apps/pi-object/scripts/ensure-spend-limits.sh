#!/usr/bin/env bash
# Makes the account's spend limits match scripts/spend-limits.json. Safe to run again: it only changes what differs.
#
#   scripts/ensure-spend-limits.sh            apply (needs Billing Edit on the token)
#   scripts/ensure-spend-limits.sh --dry-run  show what would change (Billing Read is enough)
#
# Official route: the cf CLI, `cf billing spend-policies` (list, create, update with --if-match). Each product has one
# enabled usage_block policy per account, so an existing one is updated, not duplicated. Email alerts are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
command -v cf >/dev/null || { echo "cf CLI not found" >&2; exit 1; }

POLICIES=$(cf billing spend-policies list)
node -e '
  const desired = require("./scripts/spend-limits.json").limits;
  const existing = JSON.parse(process.argv[1]);
  const dry = process.argv[2] === "1";
  const cmds = [];
  let changed = 0;
  for (const want of desired) {
    const mine = existing.filter((p) => p.product_id === want.product && p.action === "usage_block");
    const active = mine.find((p) => p.enabled);
    if (active && active.threshold_cents === want.thresholdCents && active.name === want.name) {
      console.log(`ok      ${want.product}: ${active.name} at $${want.thresholdCents / 100} (${active.id})`);
      continue;
    }
    changed++;
    if (active) {
      const args = ["billing", "spend-policies", "update", active.id, "--if-match", String(active.version),
        "--name", want.name, "--product-id", want.product, "--enabled", "true",
        "--threshold-cents", String(want.thresholdCents), "--action", "usage_block"];
      console.log(`update  ${want.product}: $${active.threshold_cents / 100} -> $${want.thresholdCents / 100} (${active.id})`);
      cmds.push(args);
    } else {
      const args = ["billing", "spend-policies", "create", "--name", want.name, "--product-id", want.product,
        "--enabled", "true", "--threshold-cents", String(want.thresholdCents), "--action", "usage_block"];
      console.log(`create  ${want.product}: $${want.thresholdCents / 100} hard cap`);
      cmds.push(args);
    }
  }
  if (dry) console.log(changed ? `dry-run: ${changed} change(s) pending, nothing applied` : "dry-run: nothing to change");
  else for (const args of cmds) console.log("  cf " + args.join(" "));
  require("fs").writeFileSync("/tmp/spend-limit-cmds.json", JSON.stringify({ dry, cmds }));
' "$POLICIES" "$DRY"

if [ "$DRY" = 0 ]; then
  node -e 'const { cmds } = require("/tmp/spend-limit-cmds.json"); for (const a of cmds) console.log(JSON.stringify(a))' | while IFS= read -r line; do
    mapfile -t ARGS < <(node -e 'process.stdout.write(JSON.parse(process.argv[1]).join("\n"))' "$line")
    cf "${ARGS[@]}" >/dev/null
  done
  rm -f /tmp/spend-limit-cmds.json
  echo "applied"
fi
