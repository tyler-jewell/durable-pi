# Template prompts: rebuild a component from one sentence

Each entry is a prompt that a zero-setup team of local agents (local LLM + local decision models, through the
MCP server) must follow to rebuild a component we removed. The prompt is the whole spec. Nothing else is
given to the team.

Status is one of: **proven** (an agent rebuilt it and it passed the check), **pending** (removed, not yet proven).

---

## jev-bash-gate-proof — pending

Add a script that submits ten shell command strings to a local decision model through MCP, without executing the commands, and checks the existing bash gate’s verdicts: four allowed, three requiring approval, and three blocked. Print PASS or FAIL for each case and exit nonzero if any call or check fails.

## report-progress-monitor — pending

Add a monitor that checks an in-progress model download every five minutes, reports the percentage and the ETA to
the team feed through `notify_ready`, and stops when the download is complete.

## model-discovery-proof — pending

Add a proof that takes a host with a local model server from nothing to a served tool: discover its models, inspect how its server runs over SSH, record the decision model as a disabled tool, enable it, make one live call through `ask_model`, and announce it to the team with `notify_ready`.

## e2e-lifecycle-audit — pending

Write an audit of the app lifecycle (create, check, test, push, delete, revive): list every MCP tool and every
surface that exists, mark which ones the lifecycle actually uses, and give the reason for each one that it does not.
