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

- Container path proven: profile matches (Node 26.13.1, git 2.39.5, wrangler 4.164.0, cf 1.0.0-rc.1, pi 1.5.2).
- The agent's write, commit, and push succeed against a bare remote.
- Not yet done: the Artifacts leg (repo create, push with a repo token, host-side verification, teardown) and the
  orchestrator that runs the whole flow and writes the session log.
