# Local e2e container (Apple container)

A deterministic run of the default `pi` agent in a fresh Apple container. The agent writes a file, commits it, and pushes
it through its own bash tool. Nothing depends on a live model.

## Runtime: Apple container, not Docker

- No Docker is involved. Apple's `container` 1.6.1 runs each container in its own lightweight Linux VM
  (Virtualization.framework). There is no Docker daemon or socket on this machine.
- `docker.io/library/node:26-bookworm-slim` is an OCI image pulled from Docker Hub. It is a registry name, not Docker
  the runtime. `Containerfile` is the standard build-file name the builder accepts.
- `container machine` is the persistent option (filesystem survives stop and start). It fits interactive work, not a
  run that must leave nothing behind, so the e2e uses one-shot `container run --rm`.

## Commands

```sh
container build -t dpi-artifacts-dev:local -f Containerfile .   # once, ~20 s with cache (builds need the builder VM)
container builder stop                                          # the builder holds 2 GiB; stop it after the build
printf '%s\n%s\n' "$REMOTE" "$TOKEN" | container run --rm --init --cpus 2 --memory 1G -i \
  dpi-artifacts-dev:local /opt/e2e/inside.sh
```

- `--init` forwards signals and reaps children (pi spawns the bash tool).
- `--cpus` and `--memory` are set explicitly. A VM does not return freed memory to the host, so caps matter.
- The remote and token come in on stdin, never on argv. The token is set as a `GIT_CONFIG` header inside the container.

## Measured (local, Apple silicon, this machine)

| Step | Time |
|---|---|
| Image build (cached) | 21 s |
| Container run, smoke (bare local remote) | 2–3 s |
| Agent: write, commit, push, finish | included above |

## Status

- **Local leg: PASS** (`npm run e2e` in apps/pi-object). Run `e2e-mwmmblef-e840`, 7.4 s wall time.
  - The container runs the real pi 1.5.2 CLI with a scripted model. It writes `e2e/hello.txt`, commits, and pushes to a
    fresh Cloudflare Artifacts repo through its bash tool.
  - The host checks the remote: HEAD equals the container's HEAD, the file content matches, the commit subject matches,
    and history is seed plus agent commit.
  - Teardown: the repo is deleted (202, async). The token is refused about 0.7 s later; the check polls rather than
    assuming. The namespace is removed if this run created it, and no container is left behind.
- Artifacts behaviour, measured: repo delete is `202 Accepted`; the token is then rejected ("Invalid or expired token"),
  after a short propagation delay.
- Logs: `~/.dpi/e2e/<run id>/` holds `run.log`, `container.log` and `result.json`. The token never appears in them.
- Remote (Cloudflare Worker) leg: not built yet.
