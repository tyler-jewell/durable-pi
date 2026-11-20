---
name: pi-subagents
description: Spawn pi subagents (separate pi processes with their own context) for parallel reads, reviews, or a second opinion. Use when work splits into independent parts, or when raw output would crowd the current context.
---

# Pi subagents

A subagent is a separate `pi` process. It has its own context window, and the parent keeps only its final answer.

## When

- Use it for independent reads or reviews that can run in parallel, for recon whose raw output would crowd the context, and for a second opinion on a diff.
- Don't use it for a single edit, for work that must share state with this turn, or for anything that needs a permission the parent does not have.

## How (the CLI; works in scripts and the dashboard)

```sh
pi --mode json -p --no-session --model <model> --tools read,grep,find,ls [--no-mcp] "<task>"
```

- `--mode json` prints one JSON event per line. `-p` exits when the task is done. `--no-session` keeps the child out of session history.
- `--tools` is an allowlist. A read-only task gets `read,grep,find,ls`.
- Add `--no-mcp` unless the task needs MCP tools. Every MCP server the child loads connects again in that child.
- Keep the LSP extension loaded in the child. Do not pass `--no-extensions`: that drops the git-gate guard.
- Pass `--model` explicitly. Without it the child uses the default model from settings.
- Use only flags that exist. `pi --help` lists them. `--no-tui` and `--json` are not pi flags: pi reports them as unknown and carries on, so a parser then reads plain text and every count is zero.
- Piped stdin is prepended to the prompt: `git diff | pi -p "Review this diff"`.

## Reading the result

- A run is finished at `agent_settled` or when the process exits. `agent_end` is not final: retries and queued work can follow it.
- The final answer is the last `message_end` event whose message role is `assistant`.
- Cost: sum `message.usage.cost.total` over the assistant `message_end` events. A child's cost is not part of your session's totals, so record it where you record your own.

## Limits

- The official subagent example runs at most 8 tasks, 4 at a time. Each child starts every extension and MCP server it loads, so a fan-out multiplies start-up cost.

## Trust the report

A subagent's report is unverified. Before a decision rests on a claim, open the cited file and line, or rerun the check. Do not act on a finding you have not verified.
