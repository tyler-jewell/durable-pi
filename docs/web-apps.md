# Web apps: scaffold, extend, verify

Every web app in this repo starts from `templates/pwa-vue`: Vue 3, Vite 8, TypeScript (vue-tsc), vue-router, and an
offline-first PWA. The `just app` recipes generate the app and its routes and pages. A browser check then verifies the
built app against Modern Web Guidance and the PWA rules.

## Commands

```sh
just app add app <name> ["Title"]          # apps/<name>, from templates/pwa-vue
just app add route <app> </path> <Name>    # src/pages/<Name>.vue and a route
just app add page <app> <Name>             # src/pages/<Name>.vue, no route
just app verify <app>                      # typecheck, build, browser checks; report in ~/.dpi/app-verify/<app>/<run>/
```

`add` refuses to overwrite a file, a route path, or a route name. `verify` starts `vite preview` and stops it when done.

## What is generated, and what you edit by hand

| Area | Who writes it | Notes |
|---|---|---|
| `src/routes.ts` | `add route` | Only the `@generated` markers are edited. |
| `src/pages/*.vue` | `add route`, `add page` | Generated; edit freely afterwards. |
| `src/main.ts`, `router.ts`, `env.d.ts`, `tsconfig.json`, `vite.config.ts` | template | Standard. Change them deliberately. |
| `vite.config.ts` manifest (name, colours) | you | Name, colours and icons are the only manifest choices. |
| `src/styles.css` | you | Design tokens (`--bg`, `--fg`, `--accent`, `--motion`) and the fluid type scale. Keep the rules listed below. |
| `src/App.vue` | you | Shell: navigation and the connection status line. |
| `src/components/AppDialog.vue` | template | Native `<dialog>`; keep it native so the browser handles focus and inertness. |

The manual surface is intentionally small: the tokens in `styles.css`, the shell in `App.vue`, and the page bodies.

## Rules the template holds, and how each is verified

Each row is checked by `just app verify` in a real browser (agent-browser, Chromium). Retrieve a guide with
`npx modern-web-guidance@latest retrieve <id>`.

| Guide | Rule | Check |
|---|---|---|
| `performance` | No layout shift on load (CLS ≤ 0.1) | `agent-browser vitals --json` |
| `responsive-design` | No horizontal overflow from 320 px to 3840 px | `scrollWidth ≤ innerWidth` at five widths |
| `fluid-scaling` | Type scales with the viewport | computed `html` font size at 320 px and 3840 px |
| `respect-os-text-scale` | Root font size is a percentage of the user's default | source check on `styles.css` |
| `motion` | Dialog motion is reduced under `prefers-reduced-motion` | computed `transition-duration`, both preferences |
| `dark-mode` | Dark and light schemes both apply | body background under `dark` and `light` |
| `color` | The page declares its colour schemes | computed `color-scheme` |
| `dialog` | Modal: background inert, focus moves in, Escape closes, focus returns | `:modal`, `activeElement`, Escape |
| project: PWA | Installable: standalone manifest, 192 and 512 PNG icons, service worker | `dist/manifest.webmanifest`, `sw.js`, the live worker |
| project: offline | Offline reload renders the app from the cache and says so | `set offline on`, reload, read `h1` and the status line |

A rule with no check is not reported as passing. Rules that are not in the list are not verified.

## Verified

- `pwa-vue` template, generated app, `just app verify`: 15 of 15 checks pass inside `browser-box`
  (Node 26, agent-browser 0.43.0, Chromium 156).
- The generator's routes and pages: the route table and the duplicate guard were checked through `just app`.

## Not yet

- A `just app` test suite for the generator logic itself (checked by use so far).
- Mobile-specific touch targets and reduced-data checks.
- A design-token audit against a brand guide.
