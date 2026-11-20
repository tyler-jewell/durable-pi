# The `.tsf` factory — a team of agents ships an app from one sentence

Adapts IndyDevDan's [`super-simple-software-factory`](https://github.com/disler/super-simple-software-factory)
(SSSF) to durable-pi, with Jev wired in as the judge. This is the implementation design for
issue #21 (deterministic SDLC phase graph as a durable job) and #20 (software-factory framing).

**Done when:** a headless `agent-browser` session opens the hub with a fresh/empty repo, and a
single message in the browser chat panel — `create app: <description>` — makes a **team** of
agents run the whole SDLC (plan → build → test → review → document → deploy) with no human
step, every phase visible in the browser as it streams.

## Why this maps cleanly

SSSF = "agent proposes, code disposes": deterministic code owns the phase graph, agents work
in bounded phases, typed envelopes cross the seams, everything streams to SQLite. durable-pi
already has the same primitives, just named differently:

| SSSF | durable-pi equivalent (already exists) |
|---|---|
| `adws/adw_*.py` phase-graph scripts | **durable jobs** (`dpi-backend/src/jobs.ts`: `release-check` is already a checkpointed phase graph) |
| coding agents in bounded phases | **subagents** (`subagent` tool, bounded toolsets, per-agent prompts) |
| typed JSON envelopes | **App State** (`read_state`/`update_state`) or a session document |
| SQLite trace + visualizer | the hub's agent tree + Tasks + the system stream |
| `sssf.config.yaml` roster | a new `.tsf/tsf.config.yaml` (the roster is data, not code) |
| `/sssf install` stamps a dotfolder | `just tsf install` stamps `.tsf/` into any repo |
| Jev (his damage-control + judge) | our `jev-damage-control` (bash gate) + a new `jev-quality` reviewer gate |

The one real gap is the **roster + phase graph as data**: today the jobs and prompts are code
in `dpi-backend`. `.tsf/` makes them a stampable dotfolder a repo carries.

## The `.tsf/` dotfolder (stamped by `just tsf install`)

```
.tsf/
├── tsf.config.yaml          # the agent roster (one agent, one model, one purpose)
├── jobs/                    # the durable-job definitions (the SDLC phase graph)
│   └── create-app.yaml      # plan → build → scout → test → review → document → deploy
├── prompts/
│   ├── planner/system.md  user.md
│   ├── builder/system.md  user.md
│   ├── scout/system.md    user.md
│   ├── reviewer/system.md user.md   # wraps Jev's verdict
│   └── documenter/system.md user.md
├── extensions/
│   └── factory-tools.ts     # registers create_app dispatch + progress tools (reuse dpi-mcp)
└── runs/                    # runtime trace (gitignored): one folder + sqlite per factory run
```

`tsf.config.yaml` roster (shape follows SSSF, but our models/providers):

```yaml
defaults:
  coding_agent: pi-durable
  provider: mesh                       # the device's provider; mesh = enabled dpi-mcp chat tools
  model: chat                          # a tag an enabled chat tool must carry
  thinking: low
  writes: []                           # repo paths an agent may change
  protected: [".tsf/jobs/", ".tsf/tsf.config.yaml"]
agents:
  - name: planner      # request → plan the builder can follow without questions
  - name: builder      # scaffold + implement (calls dpi-mcp create_app/check/test/push)
  - name: scout        # read-only recon: verify the plan's facts against the repo
  - name: reviewer     # model review + Jev quality verdict; gate before deploy
  - name: documenter   # README + changelog from the run trace
```

## The phase graph (a durable job)

`create-app` is one durable job, each phase a checkpoint, each agent a bounded subagent:

```
planner ──envelope──► builder ──► scout ──► test ──► reviewer ──► documenter ──► deploy
   │                    │          │         │          │             │
   plan                 files      facts     gate       verdict       README
```

- **planner** — `{description}` → `plan.json` (what, pages, data, stack, acceptance criteria).
- **builder** — implements from the plan; uses the existing `dpi-mcp` tools (`create_app`,
  `check`, `test`) so nothing is re-implemented; no new scaffold path.
- **scout** — read-only: checks the plan's facts (does the route exist, did the build pass).
- **test** — deterministic code (`check` + `app-smoke`/`app-verify` + the LSP gate), not an agent.
- **reviewer** — model review **+ Jev** as the quality/damage judge; a failed verdict loops back
  to the builder (bounded retries, then it waits for a human).
- **documenter** — writes the README from the run trace.
- **deploy** — the existing `push` (Workers static-assets deploy); waits for approval if
  `requireApproval` is set (reuse the durable "human near the loop" pattern).

Envelopes are typed JSON in the session document; every phase emits progress into the hub's
existing agent/task stream, so the browser shows the team working phase by phase.

## Jev integration (the part SSSF doesn't have)

- **`jev-damage-control`** (exists): gates every `bash` before it runs.
- **`jev-quality`** (new): the reviewer's verdict is a Jev `choice` (approve / revise / reject)
  plus a one-line reason, ~300 ms, on the diff — the same "bounded judgment, code owns
  thresholds" split the proactive demo used for logs, now applied to code review.
- Fail-open: if Jev is unreachable, the model reviewer's verdict stands (same rule as the
  existing bash gate).

## The browser entry

The hub already has the composer, the agent tree, Tasks (durable jobs) and the system stream.
The only new surface is a `/tsf` slash command (or a `run_durable_job` with `create-app`) that
the Main agent calls when the human types `create app: <description>`. No new UI shell — the
team's subagents appear as nested agents under the session, and their phases as tasks, so the
existing three-pane browser is the observability surface.

## Implementation order

1. **`.tsf/` stamping + roster parsing** — `just tsf install`, `tsf.config.yaml` → a loaded
   roster in `dpi-backend` (config as data, like `dpi-network.yaml`).
2. **The `create-app` durable job** — the phase graph with planner/builder/scout/test/review/
   document/deploy, reusing `dpi-mcp` for the builder's tools and the existing durable-job
   checkpointing.
3. **`jev-quality`** — Jev review verdict wired into the reviewer phase.
4. **Browser wiring** — `/tsf` + subagent/task visibility (mostly reuse; verify the nested-agent
   tree renders the team).
5. **Acceptance** — headless agent-browser, empty repo, `create app: <description>`, watch the
   team ship; measure tokens/cost per phase (the factory's own observability).

Issues: supersedes #21 (design), implements #20's framing; the MCP `create_app`/`check`/`test`/
`push` tools become the builder's hands, so no scaffold/deploy logic is duplicated.
