# End-to-end: one scenario, three targets

The same agent scenario runs on three targets with one set of checks. The scenario is in `contract.ts`: a file is
written, committed and pushed to a fresh Artifacts repo, and the host verifies the remote itself.

| Target | Agent runs in | Artifacts backend | Command |
|---|---|---|---|
| `local` | Apple container: the real pi 1.5.2 CLI, scripted model, bash `git` | Cloudflare Artifacts (deployed, `us`) | `npm run e2e` |
| `remote` | Cloudflare Durable Object (workerd), scripted model, `git_commit_push` tool | Cloudflare Artifacts (deployed, `us`) | `npm run e2e:remote` |
| `offline` | Apple container, as `local` | Artifacts local simulator (`wrangler dev`) | `npm run e2e:offline` |

The `offline` target makes no call to Cloudflare. The simulator runs on loopback, and the container reaches it through a
TCP bridge on the container's bridge address (`192.168.64.1` on this Mac). The remote URL is rewritten for the
container only. The host verifies over loopback, against the simulator itself.

## Commands (from apps/pi-object)

```sh
npm run e2e                  # local
npm run e2e:remote           # remote (deploy first: npm run deploy)
npm run e2e:offline          # offline (first run installs the simulator's dependency cache, ~1 minute)
npm run e2e:compare          # the table below, from the newest run of each target
npm run artifacts:inventory  # read-only: namespaces, jurisdictions, repo counts on the account
npm run artifacts:billing    # on demand: does the pricing page now date repository charges? (exit 3 if so)
```

Local image, once: `container build -t dpi-artifacts-dev:local -f e2e/Containerfile e2e`, then `container builder stop`.

## Scenario (identical on every target)

1. Create the repo (cloud: a fresh namespace if missing, pinned to `us`; offline: a simulator repo).
2. The agent seeds `README.md`, commits, and pushes to `main`.
3. The agent writes `e2e/hello.txt`, commits, and pushes (`e2e: agent change`), then finishes with `E2E_AGENT_DONE`.
4. The host clones the remote and checks the file, the commit subject, the history (two commits), and that the remote
   HEAD equals the agent's HEAD.
5. Teardown, on every target: the target's own state gone (container removed; the Durable Object's storage deleted,
   read back as 404; on offline, the simulator stopped and its state removed), the repo deleted, its token refused, and,
   on cloud, the account's repo count back to its baseline and the namespace removed if this run created it.

## Result (newest run of each target, `npm run e2e:compare`)

|  | Local (Apple container, Cloudflare Artifacts) | Remote (Cloudflare Durable Object) | Offline (Apple container, local Artifacts) |
|---|---|---|---|
| Run id | e2e-local-mwmsbqd4-d4d2 | e2e-remote-mwmsc0by-f750 | e2e-offline-mwmscrmv-e501 |
| Verdict | PASS | PASS | PASS |
| Checks passed | 19/19 | 19/19 | 18/18 |
| Wall time (whole run, host) | 12.5 s | 12.2 s | 7.3 s |
| Agent run (container / Worker call) | 3.5 s | 3.3 s | 3.8 s |
| Setup (namespace/simulator + repo create) | 1.4 s | 1.4 s | 2.4 s |
| Host verification of the remote | 1.2 s | 1.3 s | 0.8 s |
| Teardown | 5.7 s | 6.0 s | 0.1 s |
| Token refused after repo delete | 1.59 s | 2.74 s | immediate (simulator) |
| Runtime | Apple container (lightweight Linux VM, OCI image) | Cloudflare Durable Object (workerd), Cloudflare Computer workspace and git client | Apple container, Artifacts local simulator (wrangler dev) over a loopback bridge |
| Artifacts backend | Cloudflare Artifacts (deployed, us jurisdiction) | Cloudflare Artifacts (deployed, us jurisdiction) | local simulator (wrangler dev, loopback, bridged) |
| Cloudflare calls in the run | Artifacts API and git over HTTPS | Artifacts API and git over HTTPS | none (Artifacts local, no API) |
| Image / worker | dpi-artifacts-dev:local (digest 60debdb90a65) | https://durable-pi-object.tyler-jewell.workers.dev | dpi-artifacts-dev:local (digest 60debdb90a65) |
| Node / runtime version | v26.13.1 | workerd (Workers runtime, nodejs_compat) | v26.13.1 |
| git | 2.39.5 | @cloudflare/computer git client (isomorphic-git over the workspace) | 2.39.5 |
| wrangler / cf / pi | 4.165.0 / 1.0.0-rc.1 / 1.5.2 | wrangler 4.165.0 / pi-ai 1.5.2 | 4.165.0 / 1.0.0-rc.1 / 1.5.2 |
| CPU / memory | 2 vCPU / 1G | Workers limits (cpuMs 30000, subrequests 500) | 2 vCPU / 1G |
| Model | scripted (pi CLI, faux provider) | scripted (pi-ai faux provider) | scripted (pi CLI, faux provider) |
| Agent tools used | write, bash (git add/commit/push) | write, git_commit_push | write, bash (git add/commit/push) |
| Turns / tool calls (pi session) | 3 / 2 | 3 / 2 | 3 / 2 |
| Commit: seed + agent | 2 commits, same file, same subject | 2 commits, same file, same subject | 2 commits, same file, same subject |
| Remote HEAD matches agent HEAD | yes | yes | yes |
| File content matches e2e/hello.txt | yes | yes | yes |
| Agent state gone after run | container removed (--rm) | workspace read HTTP 404 | container removed (--rm) |
| Account repo count back to baseline | 0 before, 0 after, after 3.01s | 0 before, 0 after, after 1.56s | n/a (no account) |
| Simulator state removed | n/a | n/a | yes |
| Cloudflare cost (list, this run) | n/a (no Cloudflare run) | $0.0001570 | n/a (no Cloudflare run) |
| Durable Object requests (this run) | n/a | 1 recorded; duration posts after the response | n/a |
| Log directory | /Users/mbp/.dpi/e2e/e2e-local-mwmsbqd4-d4d2 | /Users/mbp/.dpi/e2e/e2e-remote-mwmsc0by-f750 | /Users/mbp/.dpi/e2e/e2e-offline-mwmscrmv-e501 |

## Notes

- **Apple container, not Docker.** Each container is a lightweight Linux VM through Virtualization.framework. The image is
  an OCI image from Docker Hub. `Containerfile` is the standard build file. `container machine` is for persistent
  environments; a deterministic run uses `container run --rm`.
- **Offline bridge.** The simulator's Git server listens on a loopback port that the dev server picks, and the
  simulator has no bind option. So the run starts a TCP bridge from the container's bridge address to that port. The
  bridge closes at teardown. The simulator was verified to accept requests arriving through the bridge (its `Host`
  header is not checked).
- **Net-zero on this Mac.** Per run: the simulator's `.cloudflare/` and `.wrangler/` state are removed, the bridge and
  the simulator are stopped, the clone directory and the container are removed. Kept on purpose, as caches: the image,
  and `artifacts-sim/node_modules` (491 MB, installed once).
- **Cloudflare config notes.** `bindings.artifacts({ namespace })` takes no `remote` option in `cloudflare.config.ts`.
  The simulator is the default for `cf dev`; `remote = true` is the wrangler-side switch.
- **Net-zero on Cloudflare.** The Durable Object deletes its storage whether the scenario passes or fails. The account's
  namespace is removed when the run created it, and the repo count is checked against its baseline.
- **Artifacts timing.** A repo delete returns 202 and takes effect asynchronously (cloud); the token is refused about one
  to three seconds later, so the check polls. The simulator deletes immediately.
- **Artifacts billing.** Operations and storage billing starts 19 Nov 2026. Repo-count billing is not dated yet, so each
  cloud run checks the count returns to its baseline.
- **Logs.** `~/.dpi/e2e/<run id>/` holds `run.log`, `result.json`, and `container.log` (local and offline),
  `worker-response.json` (remote), or `simulator.log` (offline). No token appears in any of them.
