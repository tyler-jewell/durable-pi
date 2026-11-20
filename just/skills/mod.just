# Agent skills for this repo: restore, add, search, remove, list. skills-lock.json pins every upstream skill.

set shell := ["zsh", "-cu"]
set positional-arguments

# CLI version used for every skills command (pinned, so the lock format does not drift)
skills_cli := "skills@1.9.0"

# Restore the skills this repo uses, exactly as skills-lock.json pins them
[no-cd]
default:
    npx -y {{skills_cli}} experimental_install -a pi -a claude-code --frozen-lockfile

# Search skill repositories (non-interactive): just skills search <query>
[no-cd]
search QUERY:
    npx -y {{skills_cli}} find "{{QUERY}}" </dev/null

# Add one skill from a repo for pi and claude-code, pin it in skills-lock.json, and stage it: just skills add <owner/repo> <skill>
[no-cd]
add REPO SKILL:
    npx -y {{skills_cli}} add "{{REPO}}" -s "{{SKILL}}" -a pi -a claude-code -y
    git add skills-lock.json ".agents/skills/{{SKILL}}" ".claude/skills/{{SKILL}}"
    @echo "staged. Review with: git status, then commit skills-lock.json and .agents/skills/{{SKILL}}"

# Remove one skill from every agent, drop it from skills-lock.json, and stage the removal: just skills remove <skill>
[no-cd]
remove SKILL:
    npx -y {{skills_cli}} remove "{{SKILL}}" -y
    git add -A skills-lock.json ".agents/skills/{{SKILL}}" ".claude/skills/{{SKILL}}"
    @echo "staged. Review with: git status, then commit the removal"

# List every installed skill with its source, pinned version and agents
[no-cd]
list:
    @node "{{justfile_directory()}}/just/skills/list.mjs"
