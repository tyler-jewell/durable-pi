# Template prompts: rebuild a component from one sentence

Each entry is a prompt that a zero-setup team of local agents (local LLM + local decision models, through the
MCP registry) must follow to rebuild a component we removed. The prompt is the whole spec. Nothing else is
given to the team.

Status is one of: **proven** (an agent rebuilt it and it passed the check), **pending** (removed, not yet proven).

---

## jev-bash-gate-proof — proven

Add a script that sends ten fixed bash commands (four read-only that must be allowed, three reversible that must
need approval, and three destructive that must be blocked) to the bash-gate decision model through the MCP registry
(`run_decision`), maps each answer through the gate in `apps/dpi-backend/src/addons.ts`, prints PASS or FAIL per
command, and exits non-zero when any verdict is wrong.

## report-progress-monitor — pending

Add a monitor that checks an in-progress model download every five minutes, reports the percentage and the ETA to
the team feed through `notify_ready`, and stops when the download is complete.

## e2e-lifecycle-audit — pending

Write an audit of the app lifecycle (create, check, test, push, delete, revive): list every MCP tool and every
surface that exists, mark which ones the lifecycle actually uses, and give the reason for each one that it does not.
