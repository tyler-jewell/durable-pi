---
name: vue-official-docs
description: Vue 3 reference for this repo's Vue apps (base-app, dpi-playground, the proactive demo, templates). Use for any Vue API, component, router, or Vue tooling question. Retrieve the official vuejs.org docs rather than recalling them.
---

# Vue (official docs)

This repo's Vue apps are Vue 3 with Vite and `vue-tsc`. For Vue behaviour, read the official docs. Do not rely on memory or on community skills.

## Where to read

- Index of every official page: https://vuejs.org/llms.txt (7 KB, organised by section). Fetch it first, then the pages the task needs.
- Sections that matter most here: Essentials, Components In-Depth, Composition API, TypeScript, Single-File Component, Style Guide, Best Practices.
- Vue Router: https://router.vuejs.org/llms.txt (the template `templates/pwa-vue` uses Vue Router 5).

## Repo rules that the docs do not state

- The Vue apps type-check with `vue-tsc` on TypeScript 5.9.3. Do not move them to TypeScript 7: `vue-tsc` does not support it yet (docs/latest-changes-2026-11-18.md, "still open").
- A `.vue` file is checked by the git gate through the Vue language server plus its TypeScript companion (pi/extensions/lsp). Run `just lsp check` after editing one.

## Procedure

1. Fetch llms.txt and pick the pages for the question.
2. Read those pages; quote the rule you rely on in your answer.
3. If the docs and the code disagree, the docs describe the framework version pinned in the app's package.json. Check the pin first.
