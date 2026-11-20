# Zero bootstrap: the proof run

One command takes this system from zero to tested local models across the mesh. The verbatim output of the run that passed (`exit 0`) is kept in git history, at commit `2fd8aae`, in this file. The current tree holds no model names: the run reads every name from discovery.

Reproduce it on a machine with the same mesh:

```bash
cd apps/dpi-mcp && npx tsx scripts/zero.mts          # the dialog; Enter submits the pre-checked set
npx tsx scripts/zero.mts --yes                     # no dialog: take the defaults
```

What the run shows:

- **Discovery** reads every host in `mesh.json` over Cloudflare Access. A host that refuses its token is reported as `access denied`, not as having no model server.
- **The dialog** pre-checks every discovered model. Enter submits; numbers toggle; `a` and `n` set all or none.
- **Live tests** are local only. Every enabled model answers the same probe: a decision for `jev-quality`, a chat reply for `agent`.
- **Realized cost** is electricity only. Opportunity (wait) cost is not counted. Cloud-equivalent cost is priced from each run's tokens against its cloud twin, and only where a twin with a catalog price exists. Nothing is called in the cloud.
- **A/B coverage** draws 300 selections per required purpose. Every eligible model is reached, and none outside the filter is.

To see the run that passed: `git show 2fd8aae:docs/zero-bootstrap-run.md`.
