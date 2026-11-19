// The language-server core, shared by the pi extension (index.ts) and the git gate (gate.mjs). Plain JavaScript with
// Node built-ins only, so the hook needs nothing installed beyond node and the servers.
//
// - LspClient: JSON-RPC 2.0 over stdio with Content-Length framing. Answers the server's own requests neutrally, so a
//   server never waits on the client.
// - LANGUAGES: which servers exist, how to detect a project that needs one, and which files each one checks.
// - Every server started by this process is killed when the process exits, so none outlives its agent or hook.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Our own install of the servers (pi/lsp/install.sh). Preferred over anything on PATH. */
export const TOOLS_BIN = join(homedir(), ".dpi", "lsp-tools", "node_modules", ".bin");
const TOOLS_MODULES = join(homedir(), ".dpi", "lsp-tools", "node_modules");

/** Default settings a server asks for, by section. Validation is on everywhere. */
export function settingsFor(section) {
  if (section === "css" || section === "scss" || section === "less") return { validate: true, lint: {}, completion: {}, hover: {} };
  if (section === "json") return { validate: true, allowComments: true, schemas: [] };
  if (section === "html") return {};
  return {};
}

const live = new Set();
export function killAllLiveServers() {
  for (const child of live) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  live.clear();
}
process.once("exit", killAllLiveServers);

export class LspClient {
  constructor(command, args, cwd) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = new Map();
    this.waiters = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderrTail = [];
    this.exited = false;
  }

  get pid() {
    return this.child?.pid;
  }

  get stderr() {
    return this.stderrTail.join("").slice(-2000);
  }

  start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    live.add(this.child);
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail.push(chunk.toString("utf8"));
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    this.child.on("exit", (code) => {
      live.delete(this.child);
      this.exited = true;
      this.failAll(new Error(`language server exited (code ${code})`));
    });
    this.child.on("error", (e) => this.failAll(e));
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Diagnostics the server last published for a document; undefined until it has published once. */
  diagnosticsFor(uri) {
    return this.diagnostics.get(uri);
  }

  clearDiagnostics(uri) {
    this.diagnostics.delete(uri);
  }

  /** Resolves with the next publish for the document. Register before sending the change that causes it. */
  waitForDiagnostics(uri, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no diagnostics for ${uri} in ${timeoutMs} ms`)), timeoutMs);
      const list = this.waiters.get(uri) ?? [];
      list.push((d) => {
        clearTimeout(timer);
        resolve(d);
      });
      this.waiters.set(uri, list);
    });
  }

  async shutdown() {
    if (!this.child || this.exited) return;
    try {
      await this.request("shutdown", null, 5_000);
      this.notify("exit");
    } catch {
      /* the server may already be gone; the kill below still runs */
    }
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.exited) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  send(msg) {
    if (!this.child || this.exited) throw new Error("language server is not running");
    const body = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(JSON.parse(body));
    }
  }

  dispatch(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      // Servers ask for their settings. Answer with the defaults an editor would send: null turns validation off in some servers.
      const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map((item) => settingsFor(item.section)) : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "LSP error"} (${msg.error.code ?? "?"})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri = msg.params.uri;
      const list = msg.params.diagnostics ?? [];
      this.diagnostics.set(uri, list);
      const waiting = this.waiters.get(uri) ?? [];
      this.waiters.delete(uri);
      for (const w of waiting) w(list);
    }
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [, list] of this.waiters) for (const w of list) w([]);
    this.waiters.clear();
  }
}

/** Files under a project root, skipping dependencies and build output. Depth-limited so a repo scan stays fast. */
const SKIP = new Set(["node_modules", "dist", ".git", ".cloudflare", ".wrangler", "coverage", "__pycache__", ".venv", "venv"]);
export function listFiles(root, accept, { depth = 6, limit = 2000 } = {}) {
  const out = [];
  const walk = (dir, d) => {
    if (out.length >= limit) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || (name.startsWith(".") && name !== ".")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (d < depth) walk(p, d + 1);
      } else if (accept(name)) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

const hasFile = (root, names) => names.some((n) => existsSync(join(root, n)));
const extOf = (p) => extname(p).toLowerCase();
const extSet = (...exts) => (name) => exts.includes(extname(name).toLowerCase());

/** Finds a server binary: ours first, then PATH. */
export function binary(name) {
  const own = join(TOOLS_BIN, name);
  if (existsSync(own)) return own;
  return name;
}

/** The TypeScript library the language server reads: the project's own, else ours, else the global one. */
export function resolveTsserver(root) {
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/lib/tsserver.js");
  } catch {
    /* not in the project */
  }
  const own = join(TOOLS_MODULES, "typescript", "lib", "tsserver.js");
  if (existsSync(own)) return own;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const p = join(globalRoot, "typescript", "lib", "tsserver.js");
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The languages. `detect` decides whether a project calls for a server; `spec` returns how to start it (or why it cannot);
 * `files` lists what it checks; `languageId` names a file for the server.
 */
export const LANGUAGES = {
  typescript: {
    label: "TypeScript / JavaScript",
    detect: (root) => hasFile(root, ["tsconfig.json", "jsconfig.json"]) || listFiles(root, extSet(".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"), { depth: 2, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")),
    languageId: (p) => ({ ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" })[extname(p).toLowerCase()],
    spec(root) {
      const tsserver = resolveTsserver(root);
      if (!tsserver) return { missing: "no TypeScript found: install it in the project, or run `just setup`" };
      return { command: process.env.DPI_LSP_TS_COMMAND ?? binary("typescript-language-server"), args: ["--stdio"], initializationOptions: { tsserver: { path: tsserver } } };
    },
  },
  json: {
    label: "JSON",
    detect: (root) => listFiles(root, extSet(".json", ".jsonc"), { depth: 3, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".json", ".jsonc")),
    languageId: (p) => (extOf(p) === ".jsonc" ? "jsonc" : extOf(p) === ".json" ? "json" : undefined),
    spec: () => ({ command: binary("vscode-json-language-server"), args: ["--stdio"] }),
  },
  css: {
    label: "CSS",
    detect: (root) => listFiles(root, extSet(".css"), { depth: 3, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".css")),
    languageId: (p) => (extOf(p) === ".css" ? "css" : undefined),
    spec: () => ({ command: binary("vscode-css-language-server"), args: ["--stdio"] }),
  },
  html: {
    label: "HTML",
    detect: (root) => listFiles(root, extSet(".html"), { depth: 3, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".html")),
    languageId: (p) => (extOf(p) === ".html" ? "html" : undefined),
    spec: () => ({ command: binary("vscode-html-language-server"), args: ["--stdio"] }),
  },
  bash: {
    label: "Bash",
    // Measured: one bash-language-server answers only the first of several documents opened together. One server per
    // file, started in parallel, answers all of them (8 of 8 in 1.3 s; one server in turn took 4.9 s).
    perFile: true,
    detect: (root) => listFiles(root, (n) => extname(n) === ".sh", { depth: 3, limit: 1 }).length > 0,
    files: (root) => listFiles(root, (n) => extname(n) === ".sh"),
    languageId: (p) => (extOf(p) === ".sh" ? "shellscript" : undefined),
    // The server would otherwise scan the whole workspace (node_modules included) in the background before answering.
    spec: () => ({ command: binary("bash-language-server"), args: ["start"], initializationOptions: { backgroundAnalysisMaxFiles: 0 } }),
  },
  python: {
    label: "Python",
    detect: (root) => hasFile(root, ["pyproject.toml", "setup.py", "requirements.txt"]) || listFiles(root, extSet(".py"), { depth: 2, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".py")),
    languageId: (p) => (extOf(p) === ".py" ? "python" : undefined),
    spec: () => ({ command: binary("pyright-langserver"), args: ["--stdio"] }),
  },
};

export const SEVERITY = ["error", "warning", "information", "hint"];

/** Starts a language's server for a project, and completes the initialize handshake. */
export async function startServer(lang, root) {
  const spec = LANGUAGES[lang].spec(root);
  if (spec.missing) return { missing: spec.missing };
  const client = new LspClient(spec.command, spec.args, root);
  client.start();
  const rootUri = pathToFileURL(root).href;
  const init = await client.request(
    "initialize",
    {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: basename(root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: false },
          publishDiagnostics: { relatedInformation: false },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
      },
      initializationOptions: spec.initializationOptions,
    },
    60_000,
  );
  client.notify("initialized", {});
  const name = init.serverInfo?.name ? `${init.serverInfo.name} ${init.serverInfo.version ?? ""}`.trim() : spec.command;
  return { client, info: name, versions: new Map(), lang };
}

/**
 * Checks a set of documents on a running server, concurrently: every document is opened (or updated) first, then all
 * the answers are awaited together. `textFor(file)` gives the text to check (the staged text, or the working copy).
 * Returns Map<file, Diagnostic[]> or the error per file.
 */
/**
 * Opens a document, or sends its new text. Returns the URI and whether this call opened it.
 * Protocol (measured against typescript-language-server 6.1.0): a server publishes diagnostics when a document is opened,
 * and after an edit only when its diagnostics change. A save (textDocument/didSave) after a change makes it re-analyse.
 */
export function syncDocument(running, file, text) {
  const { client, versions, lang } = running;
  const uri = pathToFileURL(file).href;
  const version = versions.get(uri);
  if (version === undefined) {
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: LANGUAGES[lang].languageId(file), version: 1, text } });
    versions.set(uri, 1);
    return { uri, opened: true };
  }
  client.notify("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
  client.notify("textDocument/didSave", { textDocument: { uri }, text });
  versions.set(uri, version + 1);
  return { uri, opened: false };
}

/**
 * Diagnostics for the given documents, concurrently. A new document waits for its first publish (up to timeoutMs). An
 * edited one waits for a publish for settleMs; if none comes, its diagnostics did not change, so the last published list
 * still stands. Returns Map<file, Diagnostic[] | Error>.
 */
export async function checkDocuments(running, files, textFor, timeoutMs = 15_000, settleMs = 1_500) {
  const pending = files.map((file) => {
    const text = textFor(file);
    const uri = pathToFileURL(file).href;
    const edited = running.versions.has(uri);
    const waiting = running.client.waitForDiagnostics(uri, edited ? settleMs : timeoutMs).then(
      (d) => d,
      (e) => {
        const last = edited ? running.client.diagnosticsFor(uri) : undefined;
        if (last) return last;
        throw e;
      },
    );
    syncDocument(running, file, text);
    return waiting.then((d) => [file, d], (e) => [file, e]);
  });
  return new Map(await Promise.all(pending));
}

export { basename, pathToFileURL };
