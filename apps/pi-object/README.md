# pi-object

One Durable Object per agent. The agent runs a pi-ai loop against DeepSeek, works in a Workspace (SQLite files plus a
codemode `exec` backend), and reports cost. Telemetry records what happened. Cost objects turn it into dollars, each
from the provider's own data.

```sh
npm install
npm test                # 46 tests: telemetry, cost math, budget guard, rate card, e2e contract. No network.
npm run typecheck       # TypeScript 7
npm run build           # cf build: typed Env in .cloudflare/types, from cloudflare.config.ts
npm run dev             # cf dev (workerd, local Durable Object storage)
npm run dev:verify      # end to end: the agent writes and reads a file, telemetry reaches /v1/cost, the file survives a restart
npm run deploy          # cf deploy (the account in .env; the Wrangler bundler, wrangler 4.166.0)
npx cf observability tail --worker durable-pi-object   # live logs
npm run e2e                  # offline end-to-end: local simulator, no Cloudflare call (e2e/README.md)
npm run e2e:cloud            # the same scenario against Cloudflare Artifacts (opt-in)
npm run e2e:remote           # the same scenario on the deployed Durable Object (opt-in)
npm run spend-limits:check   # preview the account spend limits (no writes)
npm run spend-limits         # apply them (needs Billing Edit)
```

Secrets live in `.env` (Cloudflare, gitignored) and `.dev.vars` (local), and in Worker secrets once deployed. The
device token is `~/.dpi/pi-object.token`. Each route requires `Authorization: Bearer <token>` and fails closed.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `PiAgent` Durable Object (agent loop, budget check, telemetry) and the Worker routes |
| `src/cost/meter.ts` | Telemetry: pi's token counts, tool calls, measured time. No prices |
| `src/cost/store.ts` | SQLite: lifetime totals, daily totals, balance samples, the cached rate card |
| `src/cost/objects.ts` | DeepSeek cost object and the free-tier rule (pure) |
| `src/cost/deepseek.ts` | DeepSeek balance reader (`GET /user/balance`, USD only) |
| `src/cost/cloudflare-rate-card.ts` | Reads the account's rate card and billing period from the Cloudflare API |
| `src/cost/cloudflare-do.ts` | Cloudflare cost object: period usage priced at the rate card (pure) |
| `src/cost/budget.ts` | Per-DO budget decision (pure) |
| `src/cost/config.ts` | The inputs the provider does not report (top-up, granted credit) and the budget cap |
| `src/cost/metered-storage.ts` | Counts SQLite rows read and written |
| `scripts/verify-do.sh` | `npm run dev:verify` |
| `scripts/ensure-spend-limits.mjs`, `scripts/spend-limits.json` | Account spend limits, one per product |
| `scripts/deepseek-export.ts` | Reconciles a DeepSeek platform export against pi session tokens (prints totals only) |
| `test/` | `usage`, `cost-objects`, `cloudflare-cost`, `budget` |

## How cost is decided

- **Telemetry is exact and carries no price.** Token counts come from pi's usage record for each model call. Tool calls
  and wall-clock time are measured here. Reasoning tokens are a subset of output, never added twice.
- **DeepSeek is derived from the balance, with no token rates.** `list = topUp + granted − balance` and
  `actual = topUp − toppedUpBalance`. `topUpUsd` is 95.00 (see Status for how it was derived). Update it after each top-up.
- **Cloudflare is priced from the account's rate card, at runtime.** The card comes from `/accounts/{id}/subscriptions`
  and `/billing/rate_plans/{plan}`, cached for 24 hours. Allowances reset on the subscription's billing period, not the
  calendar month. Dynamic Workers' included count applies each UTC day. Each line carries a rounding band of ±$0.0000005 per
  billed unit, because the card rounds unit prices to six decimals.
- **Free-tier toggle, off by default, on every object.** Off shows `listUsd`. On shows `actualUsd`, labelled
  "free-tier assumed". `POST /v1/cost/objects/<id>/free-tier {"enabled": true}`.
- **Pi's `usage.cost` is an estimate only.** It is priced from pi's catalog, which is the peak rate, so it overstates
  off-peak calls. It is recorded as `llm.<model>.estimate` and never billed from.
- **No rate table in code.** A price change needs no code change. `test/usage.test.ts` fails if the cost code names a tariff or a price table (a name check, not a full guarantee).

## Guards

- **Per-DO budget** (`BUDGET` in `src/cost/config.ts`, $5 per DO per billing period): before every model call, the DO
  adds Cloudflare spend (rate card) and LLM spend (pi's estimate) for the period. If the next call could pass the cap,
  it refuses with HTTP 402 and the decision. Without a rate card it refuses everything. The most a DO can overshoot is
  one call, and the response reports that bound.
- **Per-invocation limits** (`cloudflare.config.ts`, `worker.limits`): `cpuMs: 30000`, `subrequests: 500`.
- **Account limits** (`scripts/spend-limits.json`, applied by `ensure-spend-limits.mjs`): one enabled `usage_block` per
  product, `durable_objects` and `workers`, each $10. Cloudflare allows no per-DO or per-project spend limit, and it
  does not guarantee a maximum invoice. The per-DO budget is therefore the tighter bound.

## Status

- **Deployed** to the personal account: `https://durable-pi-object.tyler-jewell.workers.dev`. Live checks passed: 401
  without or with a wrong token; cost report with the billing period; budget present; a tiny run returned `OK`; 404 on a
  missing file.
- **DeepSeek cost, confirmed against the platform (19 Nov 2026).** Platform billing page: total cost $82.13, balance
  $12.86, granted $0 → lifetime top-up $95.00 (`topUpUsd = 95.00`, `grantedUsd = 0` in `src/cost/config.ts`). The live
  object reads `status: ok`, no config-mismatch. The earlier export reconciliation ($75.454438, diff $0.0056) also holds.
- **Namespace access is `ctx.exports` (no cast).** The Worker reaches `PiAgent` through the typed loopback binding with
  `enable_ctx_exports`; the entrypoint is imported as a module object so `cf` infers the namespace with its RPC methods.
- **Cloudflare cost**: priced at the rate card over the billing period. Cloudflare's billable-usage v2 endpoint is not
  available to this token (see Known issues), so the figure is an estimate from the card, not Cloudflare's invoice.
- **Spend limits**: the update path was run live as a round trip ($10 → $11 → $10; the cap is back at $10, version 3).
  The create path has not run live, because it applies only when a product has no policy and both do.
- **Live DeepSeek reconciliation: not yet passed.** `scripts/deepseek-reconcile.ts run` (100 calls, off-peak, $0.286 expected) gave a balance drop the batch alone did not explain. The cause is another project on this machine (`tailnet-policy`) using the same global DeepSeek key while the batch settled. `attribute` prices every local DeepSeek call in the window and reports the residual. A PASS is meaningful only in a quiet window (no other calls for several minutes, balance stable).
- **End-to-end (same scenario, two runtimes)**: `POST /v1/e2e` runs the shared scenario in the Durable Object, with a scripted model and a git tool that pushes to Artifacts. `npm run e2e:remote` drives it and is opt-in. `npm run e2e` runs the same scenario in an Apple container against the local simulator, with no Cloudflare call. `npm run e2e:compare` prints the side-by-side table. See `e2e/README.md`.
- **Key-command caching (finding)**: pi resolves an `apiKey: "!command"` per model request, not once per process. A
  five-request task ran the command five times. This package does not use `!command` keys.

## Known issues

- **Same-Worker Durable Object access is via `ctx.exports` (resolved).** The Worker reaches `PiAgent` through the typed loopback binding `ctx.exports.PiAgent` (needs `enable_ctx_exports`). `cloudflare.config.ts` imports the entrypoint as a module object (`import * as entrypoint from "./src/index" with { type: "cf-worker" }`), so `cf`'s type inference resolves the namespace with its RPC methods. No cast. This replaced the earlier `env.PiAgent as unknown as ...` cast and the self-binding.
- **`cf build` delegates to Wrangler.** The `wrangler` devDependency is required for `cf build`, so it stays pinned (4.166.0) even though the `wrangler` skill says not to add Wrangler to a `cf` project. The skill is not installed here.
- **Durable Object tests run in the Workers runtime.** `npm test` runs the logic tests under Vitest, then `test/do` through `@cloudflare/vitest-plugin` against `cloudflare.config.ts`. `dev:verify` remains the live check.
- **cf 1.0 RC and accounts.** `cf` no longer remembers the account between runs. `.env` sets `CLOUDFLARE_ACCOUNT_ID`, which `cf` reads from this directory. With one account on a profile it is used without asking; with several it prompts, and a non-interactive run fails. Status messages go to stderr, so scripts read stdout (JSON) only.
- **Artifacts permission names.** The account's permission groups are `Artifacts Read` and `Artifacts Write`. The Artifacts docs say "Edit"; the group is "Write". The deploy token needs both.
- **One DeepSeek key, several projects.** Every pi project on this machine reads the same `~/.pi/agent/auth.json`, so their calls all draw on one balance. Attribute by session (`deepseek-reconcile.ts attribute`), not by balance alone.
- **Balance is account-wide.** The DeepSeek key is shared with other tools on this account, and their spend appears
  in the balance but not in this object. A per-agent figure holds only when this agent is the only user of the key.
- **Cent precision.** Each balance reading is within ±$0.005. Cost is accurate to about a cent at any moment.
- **Settlement lags** a call by minutes, so the balance trails the telemetry briefly.
- **Pi's estimate overstates off-peak calls.** The budget guard uses it, so the guard is stricter than the bill.
- **Overshoot.** The budget guard can exceed the cap by at most one call. It does not stop a call already in flight.
- **Cloudflare CPU time** cannot be measured in-band. Wall-clock time is used as an upper bound.
- **Cloudflare billable usage v2 is not available.** `GET /accounts/{id}/billable/usage` returns 403 (error 1171,
  Restricted endpoint not enabled for this account). `POST` returns 405 (error 10405, API tokens rejected). The v1 endpoint
  returns billable overage only. Support route: dashboard → Support → Billing.
- **Calendar vs billing period.** Allowances reset on the subscription period (30 Oct to 30 Nov for `workers_paid`), read
  at runtime. A cached rate card older than its period is re-read.
- **Rate-card rounding.** The card rounds unit prices to six decimals, so the DO requests and rows-read rates appear as
  0. Those lines are shown as "rounded by the rate card" through their band, not as zero.
- **`--dry-run` only previews.** `ensure-spend-limits.mjs --dry-run` builds the request locally and does not contact
  Cloudflare. Only the apply path is live-tested.
- **Host key copy.** The DeepSeek key is stored in plaintext in `~/.pi/agent/auth.json` for host pi sessions, and as a
  Worker secret. Rotate both.
