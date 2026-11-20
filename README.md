# Durable Pi: The Durable Agent Network

> **Proactive agents start working before you sit down. They don't wait for you to work. They work for you, then wait.**
> Durable pi agents on any machine you own, driven from a web UI, a terminal, or one curl.

Watch the walkthrough: **[Pi Durable PROACTIVE Agents](https://youtu.be/DNDYYHsypZg)**

<p align="center">
  <img src="images/01_durable_agent_network.svg" alt="Three clients reach durable agents on four devices. The clients disconnect, and every device keeps checkpointing its run to SQLite." width="850">
</p>

[Pi Durable](https://earendil.com/posts/pi-durable/) persists a run through failures, through clients, and through change. This repo puts that on every machine you own. Each machine runs `dpi-backend`. The agent lives there, with its SQLite database and its tools. A web hub, `dpi-tui`, or one `curl` connects with a URL and a bearer token. Close the browser, quit the terminal, or restart the machine mid-tool, and the run picks up from its last checkpoint.

A short supervised session in one terminal is fine with plain pi. Go durable when the work has to outlive the window that started it: an event starts the agent before you sit down, several people watch the same run, or a job waits hours for a decision.

---

## The run survives the window

<p align="center">
  <img src="images/03_restart_mid_tool.svg" alt="A device restarts during a bash call. The call comes back as interrupted, and the agent resumes from its checkpoint." width="780">
</p>

A durable agent commits history, queued input, task checkpoints, and application state **before** anything is shown. Resume restores a transcript. It does not know which tool was running, what that call already changed, or what the application believed. Reopen the storage and the harness does.

A tool that may have partially run comes back as interrupted, so the agent decides what happens next instead of repeating a side effect. Replay-safe tools rerun. Once a run survives its own process, every interface is a thin client of one HTTP API. **The device owns the run. Clients only watch and steer.**

---

## One device, many clients

<p align="center">
  <img src="images/07_one_api_every_client.svg" alt="The web UI, dpi-tui, and curl all call /v1 with a bearer token. dpi-backend runs the agent and commits it to agent.sqlite." width="780">
</p>

| Piece | Where it runs | Owns |
|---|---|---|
| **`dpi-backend`** | every device, port 4780 | the harnesses, one SQLite database per session, the shared app state, the device token |
| **hub** (`apps/dpi-playground`) | your laptop, `127.0.0.1:4781` | how to reach each device, and the web client |
| **`dpi-tui`** | any terminal | nothing. It talks to the device directly |
| **`dpi-sdk`** | inside the three above | the wire contract and the one reducer both clients render |

A **device** runs one backend. A **session** is one harness and one database. An **agent** is a conversation in that session: Main, a fork, or a subagent. The [v1 API](apps/dpi-backend/API.md) addresses them by name (`/v1/sessions/release-notes/agents/main`) and streams `hello → snapshot → deltas`. A reconnect starts from a fresh snapshot, so a killed client loses nothing. **One reducer, two renderers.**

The web client is three columns: the network tree, the inspector, and the agent. The browser never sees a token. It holds one connection to the hub, and the hub opens the authenticated upstreams. `dpi-tui` is the same agent in a terminal: Enter sends or steers, Esc interrupts, and leaving the terminal does not stop the run.

```bash
just tui attach <device>:<session>:<agent>
curl -s "$URL/v1/sessions/oneshot/agents/main/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":"How many files are in this directory? Use bash.","requestId":"oneshot-1","waitMs":120000}'
```

The [backend runbook](apps/dpi-backend/README.md#demo-runbook-hop-into-an-already-running-agent) starts work in the TUI, steers it from the web, closes both clients, and restarts the device mid-tool.

---

## What the agent can do

Every change applies on the agent's next request. Nothing restarts.

- **Compaction** writes a background summary while the agent keeps working. Stored history keeps every entry. `search_history` pages through it.
- **One shared app state.** Every agent on a device reads and updates one JSON document. Each update is one atomic path, so agents do not overwrite each other. A stale full-document save gets `409`.
- **Durable jobs** are named phases, and every phase is a checkpoint. `release-check` waits for a person before it publishes. You are near the loop: you step in when a job asks for you.
- **Tools change mid-run.** Read only drops the tools that write from the next request. Model, thinking, and instructions change the same way.
- **A decision before bash.** With `jev-damage-control` on, an enabled decision tool classifies each command: allow, needs approval, or block. The verdict is remembered. If the tool is unreachable, the command runs. It is a guard, not a sandbox.
- **Fork at any entry.** The fork copies the conversation up to that point, and both agents keep going.

Screenshots of the decision gate are in [`docs/images/jev/`](docs/images/jev/). Model discovery, enablement, and metered calls are in [`apps/dpi-mcp/README.md`](apps/dpi-mcp/README.md#model-tools).

---

## Start

Open the repo in an agent and run `/install`. The command is [`.claude/commands/install.md`](.claude/commands/install.md). It checks Node 26, npm, just, and zsh, writes this machine's device config, builds the web UI, and runs `just check`. It does not start a server, and it does not touch a device other than `local`.

Or do it by hand. No provider key is required to install or run the checks. Set one in `.env` only for the provider you run.

```bash
brew install just tmux
cp .env.example .env
cp dpi-network.example.yaml dpi-network.yaml
just install
just net up local
just hub build
just check
just backend run          # :4780
just hub start            # http://localhost:4781
just tui attach local
```

npm 11 blocks install scripts until they are approved. Each approval is recorded in that app's `package.json`:

```bash
for app in dpi-sdk dpi-backend dpi-playground dpi-tui; do (cd "apps/$app" && npm install-scripts approve esbuild fsevents); done
cd apps/dpi-backend && npm install-scripts approve @google/genai protobufjs
```

`just` lists the rest: `net`, `app`, `lsp`, `backend`, `hub`, `tui`, and `test`.

---

## Devices are data

`dpi-network.yaml` declares each device by kind. No recipe names a machine. It is gitignored. Start from [`dpi-network.example.yaml`](dpi-network.example.yaml), which declares only `local`. Tokens are not in the YAML: each device generates its own, and `just net register` copies it into the hub.

| Kind | How it runs |
|---|---|
| `local` | `just backend run` on this machine |
| `ssh` | a launchd or systemd service on a machine you can reach |
| `exe-dev` | a VM behind its HTTPS proxy |
| `apple-container` | a Linux container from the macOS `container` CLI |
| `macos-vm` | a headless macOS VM, reached over SSH |
| `url` | anything already running. Register the URL and token only |

`just net up <id>` runs that kind's steps and is safe to repeat. `just net status` probes every device. An offline device keeps its last tree, dimmed, with the terminal fix for its kind.

Each device owns its agents in SQLite. The hub only stores how to reach them, so the hub can go away and the runs stay.

---

## The next chapter

The same agent is becoming one Cloudflare Durable Object per app. Code lives in Artifacts, and the object deploys from that repo. The shell is the same on every object: a generated view and an approval on the left, the object streaming itself on the right.

What is already true: `apps/pi-object` is a Durable Object with a budget guard, and an isolated container can push to an ephemeral Artifacts repo and tear it down without changing the account. What is not: a persistent Artifacts repo, deploy on push, one object per app, and the two panels showing the same thing locally and deployed. Spend is capped in code at $5 per object per period. That cap is not an invoice guarantee.

Open work is in the issue tracker. Do not treat a `status:not-ready` issue as a build.

---

## Where it can still fail

- **Checkpointed is not exactly-once.** A `requestId` is admitted once. An external effect may already have happened. Unsafe tools return interrupted. Effects need their own idempotency.
- **A token is a shell.** Anyone holding it can run commands as that device's user. `start_dirs` is not a sandbox.
- **The hub holds every token.** It binds `127.0.0.1`. Binding it to the LAN exposes every device it can reach. LAN `ssh` devices speak plain HTTP, so the token crosses the LAN in cleartext.
- **pi-durable is experimental.** This repo pins 1.6.0.

App-specific limits live with the app. The Durable Object notes are in [`apps/pi-object/README.md`](apps/pi-object/README.md#known-issues).

---

## License

MIT. See [`LICENSE`](LICENSE).
