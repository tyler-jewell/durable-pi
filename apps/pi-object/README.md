# pi-object

One Durable Object per agent. The agent runs a pi-ai loop against DeepSeek, works in a Workspace (SQLite files plus a
codemode `exec` backend), and records telemetry. Cost is computed separately, by cost objects, from the provider's
balance and our own counts.

```sh
npm install
npm test            # telemetry and cost-object validation, no network
npm run dev         # wrangler dev (workerd, local Durable Object storage)
npm run dev:verify  # end-to-end: agent runs, telemetry reaches /v1/cost, file survives a restart
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `PiAgent` Durable Object (agent loop, telemetry flush) and the Worker routes |
| `src/cost/meter.ts` | Telemetry: pi's token counts, tool calls, measured wall-clock time. No prices |
| `src/cost/store.ts` | SQLite: lifetime telemetry totals, balance samples, Dynamic Worker daily keys |
| `src/cost/objects.ts` | Cost objects and the free-tier rule (pure functions) |
| `src/cost/deepseek.ts` | DeepSeek balance reader (official `GET /user/balance`, USD only) |
| `src/cost/config.ts` | Per-project cost inputs that the provider does not report (top-ups, granted credit) |
| `src/cost/prices.ts` | Cloudflare price book. Used by the next cost object (Durable Object), not yet wired |
| `src/cost/metered-storage.ts` | Counts SQLite rows read and written |
| `test/` | `usage.test.ts` (telemetry), `cost-objects.test.ts` (cost math, toggle, balance reader) |

## How cost is decided

- **Telemetry is exact and carries no price.** Token counts are copied from pi's usage record for each model call.
  Tool calls and wall-clock time are measured in this app. Reasoning tokens are part of output and are reported as a
  subset, never added twice.
- **Cost objects turn telemetry into dollars.** Each billed service is one object with a `listUsd` and an `actualUsd`.
- **DeepSeek is derived from the balance.** `list = topUpUsd + grantedUsd − balance` and `actual = topUpUsd − toppedUpBalance`.
  No token rates are used. Set `topUpUsd` in `src/cost/config.ts` after every top-up. Until it is set, the object reports
  `unconfigured` and shows no dollars.
- **Free-tier toggle, off by default, on every object.** Off shows `listUsd`, as if no free allowance applied. On shows
  `actualUsd` and is labelled "free-tier assumed". Set with `POST /v1/cost/objects/<id>/free-tier {"enabled": true}`.
- **Pi's `usage.cost` is an estimate only.** It is priced from pi's catalog, which is the peak rate. It is recorded as
  `llm.<model>.estimate` and never billed from.
- **Freshness.** The balance is re-read at most once a minute. `GET /v1/cost/stream` pushes a report every minute.
  Balances are cent-precision, so each reading is within ±$0.005.

## Status

- `npm test`: 19 tests, all pass. `npm run dev:verify`: the agent runs, the telemetry checks pass, the file survives.
- The toggle, its error paths (400, 404, 401) and the stream were exercised on a live `wrangler dev`.
- The DeepSeek object is `unconfigured` until `topUpUsd` is set.
- The Cloudflare cost object is not built yet. It is the second cost object.
- The deployed Worker is an older build with no telemetry or cost objects. It is not redeployed.

## Known issues

- Balance is account-wide. A per-agent figure holds only when that agent is the only user of the key. Other sessions on the
  same key (such as the host pi sessions) show up in the balance, not in this object.
- Cent precision: each reading is within ±$0.005, so cost is accurate to about a cent at any moment.
- Cloudflare CPU time cannot be measured in-band. Wall-clock is an upper bound.
- Settlement lags a call by minutes, so the balance trails the telemetry briefly.
