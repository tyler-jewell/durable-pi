# Local runtime state

Nothing in this list is committed. Values stay in the files named here. `just doctor` prints a status for each required item and never prints its contents. A required item that is missing, or readable by another user, fails the command.

| Item | Location | What reads it | Permissions | Recreate |
|---|---|---|---|---|
| Backend environment | `~/.dpi/backend.env` | the device server | `0600` | `just net up` for the local device. Provider values come from the ignored `.env`. |
| Device catalog | `~/.dpi/backend/catalog.sqlite` | the device server | `0600` | Start the backend. It creates the catalog in its data directory. |
| Catalog write-ahead log | `~/.dpi/backend/catalog.sqlite-wal` | the device server | `0600` | Created with the catalog. Not required before the first write. |
| Session databases | `~/.dpi/backend/sessions/<session>/agent.sqlite` | the device server | `0600` | Open a session. |
| Pi-object device token | `~/.dpi/pi-object.token` | the Durable Object worker checks | `0600` | Create it locally and keep it out of the repo. The worker reads it as a bearer token. |
| Mesh access file | `~/.dpi-mcp/access.env` | mesh calls | `0600` | Recreate from the credential inventory. Never commit it. |
| Tool store | `~/.dpi-mcp/tools.json` | dpi-mcp | `0600` | Delete it and run discovery. Enablement comes back from `apps/dpi-mcp/policy.json`. |
| Usage meter | `~/.dpi-mcp/usage.json` | dpi-mcp | `0600` | Created on the first metered call. Entries older than 30 days are dropped. |
| Team feed | `~/.dpi-mcp/team-feed.json` | dpi-mcp | `0600` | Created on the first readiness note. Entries older than 30 days are dropped. |
| Model manifest | `~/.dpi/model-manifest.json` | a host proving its weights | `0600` | A list of content hashes only. No model name. Not required until a host serves weights. |
| Llama overlay | `llama/hosts.yaml` | `just llama` | owner-writable, gitignored | Copy `llama/hosts.example.yaml`. Record `llama_version` from `llama-server --version`. |
| Rollback plists | the overlay's `replaces` names, moved aside by apply | the host launch agent | owner-only | `just llama apply` moves the named agents aside. |

`just doctor` checks the four required files: the backend environment, the catalog, the pi-object token, and the mesh access file.
