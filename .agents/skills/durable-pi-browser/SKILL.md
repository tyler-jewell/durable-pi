---
name: durable-pi-browser
description: Browser automation rules for this repo. Use before any browser work in this repo: agent-browser, playwright-cli, the browser-box device, or the UI tests. Browsers run headless inside containers; never headed, never over VNC or a forwarded display.
---

# Browser automation in durable-pi

These rules override any example in the installed browser skills (`agent-browser`, `playwright-cli`). Some of their examples open headed browsers; this repo does not.

## Rules

- **Headless only inside containers** (the `browser-box` device and any Apple container). Never pass `--headed`, never start Xvfb, x11vnc or any VNC server, never forward a display.
- In a container, point the browser at the system Chromium and pass the no-sandbox flags through the environment, not on the command line:
  `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`, `AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage`.
- Do not automate sites that block headless browsers (for example a CloudFront "Request blocked" page). Report the block and use the site's official API instead. Do not try to evade it.
- Secrets never go in browser command arguments. Use `--password-stdin` or a protected file.

## Where this applies in the repo

- `scripts/app-verify.mts` drives `agent-browser` against a generated app (`just app verify`). It runs headless.
- `apps/dpi-playground/tests/*.mjs` use Playwright. The UI tests run headless.
- `dpi-network.yaml` `browser-box` is the container device for browser work.
