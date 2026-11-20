# Agent capability convention

Compose agent capabilities across four independently useful layers:

1. **Skill — capability:** reusable domain knowledge and operating constraints. Skills under `.agents/skills`: `agent-browser`, `agent-sandboxes-exe-dev`, `cf-cli`, `cloudflare`, `cloudflare-app-bootstrap`, `cloudflare-one`, `durable-objects`, `durable-pi-architecture`, `durable-pi-browser`, `durable-pi-infra`, `playwright-cli`, `terraform-style-guide`, `vue-official-docs`, `workers-best-practices`, `workers-development`. Skills under `.pi/skills`: `pi-subagents`.
2. **Subagent — scale:** a separate agent context for independent reads, reviews, or parallel work. The `pi-subagents` skill documents when and how to delegate.
3. **Command — orchestration:** a named, repeatable agent workflow. `.claude/commands/install.md` and `.claude/commands/prime.md` provide setup and orientation workflows.
4. **justfile — reuse:** deterministic shell commands with stable names, arguments, and validation. Root modules: `net`, `app`, `lsp`, `backend`, `hub`, `tui`, `test`, `tsf`, `llama`, `skills`.

Keep each layer independently enterable and testable. Skills explain how to do a class of work; subagents provide isolated parallel execution; commands coordinate steps that need agent judgment; just recipes encapsulate deterministic work. A higher layer may invoke a lower one, but should not duplicate its instructions or implementation. Use the narrowest layer that solves the task, and have commands finish with explicit validation evidence.
