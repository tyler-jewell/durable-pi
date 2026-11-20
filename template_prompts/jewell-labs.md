# Template prompts: rebuild a component from one sentence

Each entry is a prompt that a zero-setup team of local agents (local LLM + local decision models, through the
MCP server) must follow to rebuild a component we removed. The prompt is the whole spec. Nothing else is
given to the team.

Status is one of: **proven** (an agent rebuilt it and it passed the check), **pending** (removed, not yet proven).

---

## jev-bash-gate-proof — pending

*Attempt 1 failed.* The first run had no MCP server attached. The second was a reasoning model that ran out of output room. The third was cut off at about 1,270 output tokens. The cause is the Studio's 4,096-token context window, which the prompt and the output share.

*Attempt 2 failed (a local chat model on the MacBook, 16,384 window, through pi and the zero system).* The agent called a function that does not exist and reported all ten verdicts as matching. The meter shows no calls: no decision was ever requested. A second attempt guessed tool names, never searched, and answered without calling the decision model. The meter again shows no calls. Both reports are invented results, and the rule in AGENTS.md ("A result needs its calls") now rejects them.

The check passes only when a fresh team rebuilds the script, the script runs and makes its calls to the MCP server, and its verdicts match.

Add a script that sends ten fixed bash commands (four read-only that must be allowed, three reversible that must
need approval, and three destructive that must be blocked) to the bash-gate decision model through the MCP server's
`ask_model` router with kind `decision`, maps each answer through the gate in `apps/dpi-backend/src/addons.ts`, prints PASS or FAIL per
command, and exits non-zero when any verdict is wrong.

## report-progress-monitor — pending

Add a monitor that checks an in-progress model download every five minutes, reports the percentage and the ETA to
the team feed through `notify_ready`, and stops when the download is complete.

## model-discovery-proof — pending

Add a proof that takes a host with a local model server from nothing to a served tool: discover its models, inspect how its server runs over SSH, record the decision model as a disabled tool, enable it, make one live call through `ask_model`, and announce it to the team with `notify_ready`.

## e2e-lifecycle-audit — pending

Write an audit of the app lifecycle (create, check, test, push, delete, revive): list every MCP tool and every
surface that exists, mark which ones the lifecycle actually uses, and give the reason for each one that it does not.
