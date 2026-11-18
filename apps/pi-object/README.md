# pi-object

One Durable Object per agent. The agent runs a pi-ai loop against DeepSeek, works in a Workspace (SQLite files plus a
codemode `exec` backend), and meters every priced thing it does into a cost ledger.

```sh
npm install
npm test            # cost and tariff validation, no network
npm run dev         # wrangler dev (workerd, local Durable Object storage)
npm run dev:verify  # end-to-end: agent writes and reads a file, dev server restarts, file survives
npm run validate:deepseek -- --calls 120   # live: spends real money, reconciles against DeepSeek's balance
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `PiAgent` Durable Object (agent loop, metering) and the Worker routes |
| `src/tariff.ts` | DeepSeek tariff: schedule rule and the pi-ai model for the tariff in force at a time |
| `pricing/deepseek.json` | The one DeepSeek tariff file (rates from the DeepSeek pricing docs) |
| `pi/extensions/deepseek-tariff.ts` | Host pi extension: tariff providers and a tariff-aware virtual model |
| `src/cost/` | Ledger: price book (Cloudflare), meter arithmetic, SQLite store, metered storage |
| `test/cost.test.ts` | Validation tests |
| `scripts/deepseek-validate.ts` | Live reconciliation against DeepSeek's billing balance |

## How cost is decided

- **LLM spend is pi's metric.** Each assistant message's `usage.cost` is set by pi-ai's `calculateCost`, using the
  model that answered. The ledger records those components as they are. It never recomputes them.
- **The tariff is chosen per request by the clock.** DeepSeek charges peak rates 01:00–04:00 and 06:00–10:00 UTC,
  Monday to Friday, and half that otherwise. `deepseekModelAt(model, now)` returns the model with the tariff in force.
- **Host pi does the same routing with a virtual model.** `deepseek-tariff/deepseek-flash` routes each request to
  `deepseek-peak` or `deepseek-offpeak`. Enable the extension in `~/.pi/agent/settings.json` under `extensions`.
- **Cloudflare services** are priced from the price book in `src/cost/prices.ts`. Secrets are listed with a $0 cost.

## Status

- Ledger, tariff, and the host extension are covered by `npm test` (15 tests).
- The live DeepSeek reconciliation has not been run against a metered batch. Billing settles several minutes after a
  call, so the check has to wait for settlement.
- The deployed Worker (`durable-pi-object.flagseeker.workers.dev`) is an older build: file tools only, no cost ledger.
  It is not redeployed. The personal account is set in `.env`, which Wrangler reads automatically.

## Known issues

- DeepSeek has no usage or cost endpoint and no machine-readable price list. The tariff comes from the docs and is
  checked by reconciliation.
- Balance is account-wide. A per-agent reconciliation holds only when that agent is the only user of the key.
- Chinese public holidays are peak per DeepSeek's page. They are not in the schedule.
- Cloudflare CPU time cannot be measured in-band. Wall-clock is an upper bound, labeled `estimated`.
- Ledger SKUs changed from `llm.deepseek.deepseek-flash.*` to `llm.deepseek-flash.*`. Local dev state still holds rows
  under the old names.
- The DeepSeek key command (`pi auth print-api-key`) is documented to run once per pi process and be cached. That is not
  observed in this setup yet.

Design and triage are tracked in the repository's issues: #2 (cost model) and #1 (LSP triage).
