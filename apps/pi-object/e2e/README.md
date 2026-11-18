# End-to-end: one scenario, two runtimes

The same agent scenario runs on two targets with one set of checks. The scenario is in `contract.ts`. Each run pushes a
file to a fresh Cloudflare Artifacts repo, and the host verifies the remote itself.

- **Local:** the real pi 1.5.2 CLI in an Apple container. Its model is scripted, and it pushes with bash `git`.
- **Remote:** the deployed `PiAgent` Durable Object (Workers, `@cloudflare/computer` workspace and git client). Its model
  is pi-ai's faux provider, and it pushes with a `git_commit_push` tool.

## Commands (from apps/pi-object)

```sh
npm run e2e                 # local: Apple container
npm run e2e:remote          # remote: the deployed Worker (must be deployed first: npx wrangler deploy)
npm run e2e:compare         # the table below, from the newest runs
```

Local image, once: `container build -t dpi-artifacts-dev:local -f e2e/Containerfile e2e`, then
`container builder stop`. See the Apple container notes below.

## Scenario (identical on both targets)

1. Create the namespace (if missing) and a repo named for the run.
2. The agent seeds `README.md`, commits, and pushes to `main`.
3. The agent writes `e2e/hello.txt`, commits, and pushes (`e2e: agent change`), then finishes with `E2E_AGENT_DONE`.
4. The host clones the remote and checks the file, the commit subject, the history (two commits), and that the remote
   HEAD equals the agent's HEAD.
5. Teardown: repo deleted, token refused (polled), namespace removed if this run created it, and the target's own state
   gone (container removed; the Durable Object's storage deleted, read back as 404).

## Result (newest run of each target, from `npm run e2e:compare`)

|  | Local (Apple container) | Remote (Cloudflare Durable Object) |
|---|---|---|
| Run id | e2e-local-mwmmmjpc-da2d | e2e-remote-mwmmmps0-b973 |
| Verdict | PASS | PASS |
| Checks passed | 17/17 | 17/17 |
| Wall time (whole run, host) | 7.4 s | 7.6 s |
| Agent run (container / Worker call) | 3.4 s | 3.3 s |
| Namespace + repo create | 1.1 s | 1.4 s |
| Host verification of the remote | 0.8 s | 0.9 s |
| Teardown (repo, token, namespace) | 2.0 s | 2.0 s |
| Token refused after repo delete | 1.07 s | 0.71 s |
| Runtime | Apple container (lightweight Linux VM, OCI image) | Cloudflare Durable Object (workerd), Cloudflare Computer workspace and git client |
| Isolation unit | one Linux VM per container | one Durable Object (isolate per object) |
| Image / worker | dpi-artifacts-dev:local (digest 371c1eb7ce17) | https://durable-pi-object.tyler-jewell.workers.dev |
| Node / runtime version | v26.13.1 | workerd (Workers runtime, nodejs_compat) |
| git | 2.39.5 | @cloudflare/computer git client (isomorphic-git over the workspace) |
| wrangler / cf / pi | 4.164.0 / 1.0.0-rc.1 / 1.5.2 | wrangler 4.164.0 / pi-ai 1.5.2 |
| CPU / memory | 2 vCPU / 1G | Workers limits (cpuMs 30000, subrequests 500) |
| Model | scripted (pi CLI, faux provider) | scripted (pi-ai faux provider) |
| Agent tools used | write, bash (git add/commit/push) | write, git_commit_push |
| Turns / tool calls (pi session) | 3 / 2 | 3 / 2 |
| Commit: seed + agent | 2 commits, same file, same subject | 2 commits, same file, same subject |
| Remote HEAD matches agent HEAD | yes | yes |
| File content matches e2e/hello.txt | yes | yes |
| Agent state gone after run | container removed (--rm) | workspace read HTTP 404 |
| Cloudflare cost (list, this run) | n/a (local run) | $0.0001570 |
| Durable Object requests (this run) | n/a | 1 recorded; duration posts after the response |
| Log directory | /Users/mbp/.dpi/e2e/e2e-local-mwmmmjpc-da2d | /Users/mbp/.dpi/e2e/e2e-remote-mwmmmps0-b973 |

## Notes

- **Apple container, not Docker.** Each container is a lightweight Linux VM through Virtualization.framework. The image is
  an OCI image from Docker Hub. `Containerfile` is the standard build file. `container machine` is for persistent
  environments; a deterministic run uses `container run --rm`.
- **Local flags.** `--init` (signal forwarding and reaping, pi spawns children), `--cpus 2 --memory 1G` (a VM does not
  return freed memory), stdin for the remote and token, and `container builder stop` after builds.
- **Remote needs** `@platformatic/vfs` (optional peer of `@cloudflare/computer/git`, pinned 0.5.0).
- **Net-zero on Cloudflare:** the Durable Object deletes its storage whether the scenario passes or fails, and the
  account's Artifacts namespace is removed when the run created it.
- **Artifacts timing:** a repo delete returns 202 and takes effect asynchronously. The token is refused about one second
  later, so the check polls for it.
- **Logs:** `~/.dpi/e2e/<run id>/` holds `run.log`, `result.json`, and `container.log` (local) or `worker-response.json`
  (remote). No token appears in them.
- **Cost of a remote run:** the scripted model costs nothing. The Cloudflare cost shown is the list price of this run's
  Durable Object usage at the account's rate card. The DeepSeek balance is unchanged.
