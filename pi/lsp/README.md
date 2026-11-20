# Language servers for agents, and the git gate

Pi has no built-in language-server support. `pi/extensions/lsp` adds it: four tools (`lsp_diagnostics`, `lsp_definition`,
`lsp_hover`, `lsp_references`), a status line per language at session start, and a pre-commit gate that shares the same code.

## The model

1. **A workspace is one repository checkout.** For a Durable Object app that is the app's repo. The servers run beside the
   checkout (a laptop, a container, a device), never inside the Durable Object: a Worker cannot spawn a process.
2. **The files decide the servers.** `scanWorkspace()` lists eligible paths from the Git index, applying
   `gate-exclude.txt` and counts file extensions. The table in `core.mjs` (`LANGUAGES`) maps each extension to
   a language. A server starts for each language that has files, and for no other. `just lsp plan` prints the table.
3. **One server per language, never more.** The TypeScript server finds each file's own `tsconfig`, so a monorepo with twenty
   projects still has one. `Workspace` keeps a `Map` keyed by language and memoises starts. Vue adds one server, and uses the
   TypeScript server (with the Vue plugin) for type checks; its own server adds template syntax checks.
4. **No timer decides an answer.**

   | Language | Strategy | How an answer is known |
   |---|---|---|
   | TypeScript, JavaScript, Vue types | `tsserver` | ask tsserver (`syntactic/semantic/suggestionDiagnosticsSync` through `typescript.tsserverRequest`) |
   | JSON, CSS, HTML | `pull` | LSP `textDocument/diagnostic`: one request, one answer |
   | Bash, Python, Vue templates | `push` | a `publishDiagnostics` counts only when it carries the version of the text we sent |

   A file that no `tsconfig` includes is reported as a finding (tsserver would check it with default settings, which is no check).
   A server that is missing, dies, or stays silent fails the file: a document is never reported clean on silence.

## File scope

The tools and the git gate check supported regular files recorded in the project’s Git index.
New files qualify once staged. Untracked files, symlinks, excluded paths, and paths outside the
checkout are never sent as files to check. A directory without a Git index has no eligible files.
For scratch shell scripts, use `bash -n` and, if available, `shellcheck`.

## Memory

The TypeScript server is the one process whose memory grows with the project. It runs as a single process (no separate syntax
server), with type acquisition off, and a heap ceiling (`DPI_LSP_TS_MEMORY_MB`, default 1536). A whole-repo check works one
project at a time and closes the documents it opened. If the server outgrows its heap and exits, it is restarted once.
Measured on this repo (18 TypeScript projects and 3 Vue projects), checking every file: 36 s and 1.1 to 1.4 GB peak for the one
server. The old layout, one server per project, held about 2.2 GB resident across 54 processes before checking a single file.

## Reload

`install.sh` installs `core.mjs` as `core.<hash>.mjs` and points `index.ts` at it. Pi caches a module by path for the life of
the process, so a `/reload` that found `core.mjs` again ran the old core under the new `index.ts`. A new hash is a new path.

## Where it is installed

The extension lives in the repo, not in the agent folder (`~/.pi/agent`), so only this repo's sessions load it and no other
project on the machine sees it. `just lsp install` (or `sh pi/lsp/install.sh .`) writes it to `.pi/extensions/lsp`, which is
version controlled: commit it with any change to `pi/extensions/lsp`. Pi loads project extensions only after project trust is
granted (`defaultProjectTrust`, see the settings docs). `LSP_EXTENSION_DIR` moves the install elsewhere; the tests and the
container eval use it.

`just lsp test` checks the copy as well: `pi/lsp/check/tracked.sh` installs into a scratch folder and fails if
`.pi/extensions/lsp` differs from what the source produces.

## Tests

| Command | What it proves | Needs |
|---|---|---|
| `just lsp test` | the gate (21 cases, real servers; the last two commit through `.githooks/pre-commit` itself), the extension in a real pi session with a scripted model (plan, one server per language, every strategy, edit then re-check, bypass blocked, nothing left behind) in two layouts (agent folder, and a project's `.pi/extensions/lsp` loaded by trust), `/reload` (a changed build is picked up; the old layout is caught), and the tracked copy matches the source | nothing |
| `just lsp eval` | a real model (DeepSeek Flash) given tasks that never mention language servers: does it reach for them, and is the repo clean? Three cases, each in its own Apple container, each under 20 s | the container system, a DeepSeek key |
| `just lsp check` | every file in the repo is clean by the servers' standard | nothing |

`CONTROL=none just lsp eval` runs the evals without the extension: every case must then fail, which shows they can tell.
