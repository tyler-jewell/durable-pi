#!/usr/bin/env node
// Makes the account's spend limits match scripts/spend-limits.json. Safe to run again: it only changes what differs.
//
//   node scripts/ensure-spend-limits.mjs            apply (needs Billing Edit on the token)
//   node scripts/ensure-spend-limits.mjs --dry-run  list, and preview each pending change (cf --dry-run prints the
//                                                   request only: Cloudflare is NOT contacted). Billing Read is enough.
//
// Official route: the cf CLI, `cf billing spend-policies` (list, create, update with --if-match). Cloudflare allows one
// enabled usage_block policy per product per account, so an existing one is updated, never duplicated. Notification
// policies are not touched. SPEND_LIMITS_FILE overrides the spec (used to validate a change without applying it).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const run = (args) =>
  new Promise((resolve, reject) =>
    execFile("cf", args, { maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`cf ${args.join(" ")}: ${stderr || err.message}`)) : resolve(stdout),
    ),
  );

const dry = process.argv.includes("--dry-run");
const specPath = process.env.SPEND_LIMITS_FILE ?? fileURLToPath(new URL("./spend-limits.json", import.meta.url));
const { limits: desired } = JSON.parse(await readFile(specPath, "utf8"));
const existing = JSON.parse(await run(["billing", "spend-policies", "list"]));

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const pending = [];
for (const want of desired) {
  const mine = existing.filter((p) => p.product_id === want.product && p.action === "usage_block");
  const active = mine.find((p) => p.enabled);
  if (active && active.name === want.name && active.threshold_cents === want.thresholdCents) {
    console.log(`ok      ${want.product}: ${want.name} at ${dollars(want.thresholdCents)} (${active.id})`);
    continue;
  }
  const flags = ["--name", want.name, "--product-id", want.product, "--enabled", "true",
    "--threshold-cents", String(want.thresholdCents), "--action", "usage_block"];
  if (active) {
    console.log(`update  ${want.product}: ${dollars(active.threshold_cents)} -> ${dollars(want.thresholdCents)} (${active.id})`);
    pending.push(["billing", "spend-policies", "update", active.id, "--if-match", String(active.version), ...flags]);
  } else {
    console.log(`create  ${want.product}: ${want.name} at ${dollars(want.thresholdCents)}`);
    pending.push(["billing", "spend-policies", "create", ...flags]);
  }
}

if (pending.length === 0) {
  console.log("nothing to change");
} else if (dry) {
  for (const args of pending) {
    if (process.env.DEBUG) console.log(await run([...args, "--dry-run"]));
    console.log(`preview: cf ${args.slice(2, 4).join(" ")} (request built locally; not sent)`);
  }
  console.log(`dry-run: ${pending.length} change(s) previewed, nothing sent`);
} else {
  for (const args of pending) {
    await run(args);
    console.log(`applied: cf ${args.slice(2, 4).join(" ")}`);
  }
}
