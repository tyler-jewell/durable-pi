# Public onboarding plan

This is a plan, not a build. A stranger should reach a running demo without reading the long install section first.

## README

Keep the current install section. Add a short Quick start above it: one command, the proof that command prints, and a link to the rest. Diagrams stay as the existing SVG files. Do not switch the README to default Mermaid. A new diagram is a hand-made SVG next to `images/`, using the same palette as the ones already there.

## One command

`just setup` then `just verify-setup`. The second command is the proof. A missing provider key is not a failure: the deterministic provider runs with no key. Cloudflare sign-in is a later step, not the first screen.

## Three surfaces

- **Admin.** The session that holds the admin bearer token. It is the only session that lists token and delete tools.
- **Demo app.** The base app shell, served as a static site. It shows a job waiting for approval.
- **MCP server.** `dpi-mcp`, reached with its bearer token. Model tools come from discovery. The onboarding page names the server and the token variable, not a model.

## Cloudflare sign-in

The first Cloudflare step opens the official OAuth consent screen for the permissions the mesh and the app deploy need. It refuses to run unless the account name matches the one in the ignored environment file. Token values stay out of the repo. A public reader without that account stops after the local demo.

## Not in this plan

A wipe of an existing account, a one-click deploy of the mesh, and a phone push. Those stay separate issues.
