# IndyDevDan (`disler`) deep-dive — research and decision guide

Tracking issue: **#15** (Deep-dive IndyDevDan videos + repos; apply to durable-pi).

This is the guide to go through when planning the remaining work and its validation. It maps each of IndyDevDan's
repos (and the videos that explain them) onto **durable-pi**, states what transfers, and records a decision
(adopt / adapt / skip) with a reason. The cross-cutting discussion items at the end are the agenda; each "adopt /
adapt" item is a candidate follow-up issue.

How to read the decision column:

- **adopt** — take the pattern largely as-is; it fills a real gap and matches our architecture.
- **adapt** — extract the idea and re-implement it in our structure (not a copy of his code).
- **skip** — we already have an equivalent, or it does not serve "persistent multi-device durable agents".

---

## 1. Upstream drift (the "catch up with `disler/durable-pi`" step)

**Result: there is nothing to port.**

- `upstream/main` = `37165c6` and `merge-base(upstream/main, origin/main)` = `37165c6`. Upstream has **0 commits ahead** of
  our fork; we are **95 commits ahead**.
- The only upstream content we removed is `ai_docs/` (his vendored AI documentation). That was a deliberate removal
  recorded in our README ("`ai_docs/` and the pi-object spike harnesses are already gone").
- Conclusion: the value is **not** in his `durable-pi` repo (it is our fork's past). The value is in his **other**
  repos and in the videos, which describe systems *above* durable-pi.

---

## 2. Per-repo review

### Core agentic patterns

| Repo (stars) | What it is | Transferable idea | Decision |
|---|---|---|---|
| `super-simple-software-factory` (1058) | One skill (`/sssf install`) stamps a full "software factory" into any repo. Deterministic Python owns the SDLC graph (plan → build → test → fix → review → revise → document → commit); coding agents are **bounded phases** inside it. Typed JSON envelopes carry context across phase seams; every event streams into SQLite. `kind="code"` phases replace agents for anything already deterministic (run `bun test`, `ruff check`). | "Agent proposes, code disposes." Our `dpi-backend` already has durable jobs + the LSP git gate, but **not** a first-class deterministic SDLC phase graph with typed envelopes and per-phase acceptance gates. The jobs graph is the natural home. | **adapt** — see discussion items A, I |
| `fusion-harness` (608) | A Pi extension that runs 2–5 models on the same problem: one architect, one primary builder, up to three secondary builders, a sole-writer FUSION agent that merges, and **gate-first validation** (the validator authors the acceptance gate before the builder writes a line). | Two ideas: (1) "gate-first" — write the test that proves the work before the work; (2) model fusion. We are deliberately on free-tier `@cf/*` models, so fusing frontier models is not our cost story, but gate-first validation is independent of model choice. | **skip** fusion, **adapt** gate-first — see item C |
| `infinite-agentic-loop` (622) | Two-prompt loop: a spec file + parallel subagents that each generate an iteration, in waves, with QA for uniqueness/compliance. | Best-of-N generation. POC quality; our durable job graph is more structured, and the sandbox "best of N" idea below generalizes it. | **skip** for now — see item B |
| `indydevtools` (183) | His 2024 agentic toolbox. | Superseded by his newer repos above. | **skip** |

### Hooks / guards / observability

| Repo (stars) | What it is | Transferable idea | Decision |
|---|---|---|---|
| `claude-code-hooks-mastery` (3988) | Hooks lifecycle, `uv` single-file hook scripts, a meta-agent, team-based validation, status lines. | We already use Pi extension hooks (e.g. the LSP gate blocks `git commit --no-verify`). The reusable pieces are the **meta-agent** (an agent that inspects other agents) and **team-based validation** (a reviewer agent is a gate before merge). | **adapt** — see item H |
| `claude-code-hooks-multi-agent-observability` (1572) | Hooks → HTTP POST → SQLite → WebSocket → Vue: a live dashboard of every tool call, handoff and lifecycle event. | We already built this as a product feature: hub SSE stream, pi-object telemetry + cost objects, the base-app system stream, "observability is the feature". His is a bolt-on; ours is durable and per-DO. | **skip** (already have a stronger equivalent) |
| `claude-code-damage-control` (480) | `PreToolUse` hooks with **deterministic** path lists: `zeroAccessPaths`, `readOnlyPaths`, `noDeletePaths`, plus dangerous-command patterns. | Our `jev-damage-control` is *semantic* (a model call, ~300 ms, and runs the command if Jev is unreachable). His path/pattern guards are *local and instant*, so they close the "Jev is down" gap. | **adapt** — see item D |
| `bash-damage-from-within` (85) | Five levels of bash security; the thesis is "default to L3, production L4/L5". L3 = deny-list dangerous commands + path protections, L4 = allow-list, L5 = sandbox-only. | Directly relevant: our device agents hold `bash` on devices that may have production CLIs (Cloudflare, exe.dev). We are roughly at L2/L3 today (Jev + one BYPASS regex). This is the clearest near-term hardening. | **adopt L3, plan L4/L5** — see item D |

### Sandboxes / devices

| Repo (stars) | What it is | Transferable idea | Decision |
|---|---|---|---|
| `agent-sandboxes` (94) | E2B sandboxes + Claude Code (obox / ibox / sandbox CLI / MCP). | We already have our own device kinds (`exe-dev`, `apple-container`) and the `agent-sandboxes-exe-dev` skill. E2B specifically adds nothing over exe.dev + Cloudflare. | **skip** (have the pattern) |
| `agent-sandbox-skill` (394) | One skill for isolated execution environments; full-stack scaffold, browser automation, lifecycle management. | Same as above; the lifecycle-management verbs (mount, exec, teardown, reboot) are already `just net up/status/logs/destroy`. | **skip** (have the pattern) |
| `inkwell-agent-sandboxes-and-software-factory` (169) | "Factory in a box": three tiers — host orchestrator, in-sandbox orchestrator, ADW agents — all inside a throwaway exe.dev VM. Two scripts mount/teardown; each sandbox gets a **fresh OpenRouter key with a hard spend cap**, revoked at teardown; live app URL + live factory observability URL; **Best of N** (one prompt, five sandboxes, pick the winner). | This is the closest thing to our stated end-state (phase 3: one Durable Object per app, spend caps, deployed via Workers Builds). The "factory in a box" framing, disposable credentials, and Best-of-N are the transfers. Note: our **per-DO budget guard ($5) + account caps** already implement "bounded blast radius" more strictly than his fresh-key approach. | **adopt the framing, adapt Best-of-N** — see items A, B, E |
| `agentic-drop-zones` (204) | Watchdog watches folders; a dropped file loads a prompt template and fires an agent. | Our **proactive demo** (Jev log watcher → incident brief → durable deploy approval) is a strictly more capable version of "event → proactive agent". | **skip** (proactive demo generalizes it) |

### Browser / computer use

| Repo (stars) | What it is | Transferable idea | Decision |
|---|---|---|---|
| `bowser` (268) | A four-layer browser stack: **skill** (capability) → **subagent** (scale) → **command** (orchestration) → **justfile** (reusability). Enter at any layer. | We have the pieces (agent-browser, playwright-cli, browser-box device, UI tests); the 4-layer discipline is a good organizing principle for our skills/commands. | **adapt the layering**, low priority — see item G |
| `big-3-super-agent` (296) | Gemini computer use + realtime + multi-agent experiment. | Superseded. | **skip** |
| `anthropic-computer-use-bash-and-files` (146) | Early computer-use. | Superseded. | **skip** |

### Distribution / install / misc

| Repo (stars) | What it is | Transferable idea | Decision |
|---|---|---|---|
| `install-and-maintain` (103) | "A living document that executes": deterministic scripts do the work, agents provide oversight; `just` is the launchpad; an `/install` command the agent can run. | Our `just install` / `just setup` + `.claude/commands/{install,prime}.md` already exist, but setup is human-run. Making setup agent-executable (the agent can `just setup` and self-verify) matches "agents + code beats agents". | **adapt**, low priority — see item F |
| `fork-repository-skill` (158) | Skill to fork your terminal agent into a new window for parallel/branch work. | We have fork/steer/parallel in the product already (`/fork`, subagents, `just tui`). | **skip** |
| `beyond-mcp` (131) | MCP vs CLI vs filesystem scripts vs skills; context-loss tradeoffs. | We already prefer custom Pi extensions + skills + CLIs over MCP-heavy tooling (the LSP is an extension, not an MCP server). This validates our choices rather than adding work. | **skip** (consistent with us) |
| `aider-mcp-server` (309) | Minimal MCP server for Aider. | We do not use Aider. | **skip** |

---

## 3. Cross-cutting discussion items (the agenda for planning + validation)

These are the decisions to work through, roughly in priority order. Each names the repo/video it came from and the
concrete change it implies.

### A. Do we turn durable-pi's job graph into a first-class deterministic SDLC?
- Source: `super-simple-software-factory`, `inkwell…`, videos "My Super Simple Software Factory", "ZERO to RUNNING".
- Today we have durable jobs (list/run/approve), the LSP git gate, and per-DO budget guards. We do **not** have a
  named, gated phase graph (plan / build / test / fix / review / revise / document / commit) with typed envelopes
  between phases and automatic "failed gate → back to the builder" loops.
- To decide: is the SDLC graph a new `dpi-backend` job type, a new extension, or out of scope until the DO demo is
  live? Which phases are `kind="code"` (deterministic) vs `kind="agent"`? Where do the LSP gate and the git gate sit in
  the graph?

### B. Best-of-N runs (and harvesting cost/quality data)
- Source: `inkwell…`, `infinite-agentic-loop`, videos "Factory In A Box", "NEEDS Agent Sandboxes".
- One prompt, N sandboxes/agents/configs, pick the winner. We already have per-DO telemetry + cost objects, so the
  "harvest cost/quality per config for free" half is nearly free for us.
- To decide: does Best-of-N belong at the device level (multiple `apple-box`/`exe-dev` runs) or the DO level (multiple
  Durable Objects per app)? Who picks the winner — a human, a reviewer agent, or a gate?

### C. Gate-first validation (prove the work before it's written)
- Source: `fusion-harness`, video "FUSE THEM".
- A validation gate is authored *before* the builder agent works; the validator runs it and feeds failures back. This is
  orthogonal to our model stack (works with `@cf/*`).
- To decide: adopt as a durable-pi prompt/extension convention ("every task first names how its done is proven"), and
  whether the reviewer agent that owns the gate is the existing approval step or a new bounded agent.

### D. Deterministic local guards around `bash` (L3, then L4/L5)
- Source: `claude-code-damage-control`, `bash-damage-from-within`, videos "DELETE the BASH TOOL", "10 Levels of Jev".
- We rely on `jev-damage-control` (semantic, remote, and "run if Jev is down"). Add deterministic, instant guards in the
  Pi extension's `tool_call` hook: dangerous-command deny-list + `zeroAccess` / `readOnly` / `noDelete` paths per device
  kind. Default L3; L4 (allow-list) and L5 (sandbox-only) for devices with production CLIs.
- To decide: exact deny-list and path policy per device kind (local / ssh / exe-dev / apple-container / DO), and how the
  policy is configured (device YAML) and tested (the `bash-damage-from-within` attack battery is a ready-made validation
  suite).

### E. "Factory in a box" and disposable credentials
- Source: `inkwell…`, video "Factory In A Box".
- Frame the durable-pi system as a factory; the Durable Object (or sandbox) is the box. We already have the credential
  boundary (per-DO budget guard $5, account caps $10). 
- To decide: do we adopt his mount/run/teardown-as-the-asset framing for our `just net up/status/logs/destroy`, and do
  we add a "live observability URL per box" to match his "private factory URL"? (We have the base-app system stream; is
  it exposed per DO?)

### F. Agent-executable setup
- Source: `install-and-maintain`.
- Make `just setup` / `just install` something an agent can run and self-verify (a cookbook the agent executes, not a
  human). We have `.claude/commands/install.md`; extend it so the agent verifies each step (the LSP check already gives
  us a way to prove the install worked).
- To decide: is this worth it now, or only when onboarding real devices/D O apps?

### G. Four-layer composable skill/command discipline
- Source: `bowser`, video "4-Layer Playwright CLI Skill".
- Standardize our skills/commands/subagents/just recipes into the same four layers, so each capability is testable at
  each layer. We already have most of this.
- To decide: adopt as a style convention (and document it) rather than a code change.

### H. Meta-agent / team-based validation
- Source: `claude-code-hooks-mastery`.
- An agent that inspects other agents, and a reviewer agent as a merge gate. This maps to our approval flow and to the
  LSP gate's "review before commit".
- To decide: is the reviewer a new bounded agent in the SDLC graph (item A), or is the human approval step enough for
  the demo?

### I. Validation of "remaining work"
- What proves the system? The LSP suites (`just lsp test`, `just lsp eval`), the device suite (`just test device`), the
  e2e (`just test e2e`), the proactive demo, and pi-object's e2e (local/remote/offline). Each discussion item above
  should name the test that proves it before it is "done" — matching his "observable" and "gate-first" principles.

---

## 4. Suggested follow-up issues

From the decisions above, the concrete issues to file are:

1. **adopt**: deterministic local `bash`/path guards in the Pi extension (item D) — highest value, lowest risk.
2. **adapt**: a named, gated SDLC phase graph in `dpi-backend` (item A) — needs a design discussion first.
3. **adopt**: Best-of-N runs with cost/quality harvesting (item B).
4. **adapt**: gate-first validation convention (item C).
5. **adapt**: per-DO live observability URL / "factory in a box" framing (item E).
6. **adapt**: agent-executable `just setup` (item F).

(These are the same decisions this guide documents; filing them as issues turns "adapt/adopt" into tracked work.)
