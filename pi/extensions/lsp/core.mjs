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
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ line: number, character: number }} Position */
/** @typedef {{ start: Position, end: Position }} Range */
/** @typedef {{ range: Range, severity?: number, code?: string | number, source?: string, message: string }} Diagnostic */
/** @typedef {"typescript" | "vue" | "json" | "css" | "html" | "bash" | "python"} LangId */
/** @typedef {{ missing: string } | { command: string, args: string[], initializationOptions?: object }} ServerSpec */
/** @typedef {{ label: string, perFile?: boolean, detect: (root: string) => boolean, files: (root: string) => string[], languageId: (p: string) => string | undefined, spec: (root: string) => ServerSpec }} Language */
/** @typedef {{ client: LspClient, info: string, versions: Map<string, number>, lang: LangId }} Running */
/** @typedef {(list: Diagnostic[] | undefined, err?: Error) => void} Listener */

/** Our own install of the servers (pi/lsp/install.sh). Preferred over anything on PATH. */
export const TOOLS_BIN = join(homedir(), ".dpi", "lsp-tools", "node_modules", ".bin");
const TOOLS_MODULES = join(homedir(), ".dpi", "lsp-tools", "node_modules");

/** Default settings a server asks for, by section. Validation is on everywhere. */
/** @param {string | undefined} section */
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
  /** @param {string} command @param {string[]} args @param {string} cwd */
  constructor(command, args, cwd) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
    this.child = undefined;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map();
    /** @type {Map<string, Diagnostic[]>} */
    this.diagnostics = new Map();
    /** @type {Map<string, Set<Listener>>} */
    this.listeners = new Map();
    /** @type {Map<string, Array<(params: any) => void>>} */
    this.notificationHandlers = new Map();
    /** Latest list per source per document: the server itself, and any companion that also reports on its documents. @type {Map<string, Map<string, Diagnostic[]>>} */
    this.sources = new Map();
    this.buffer = Buffer.alloc(0);
    /** @type {string[]} */
    this.stderrTail = [];
    this.exited = false;
  }

  /** @returns {number | undefined} */
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

  /** @param {string} method @param {unknown} params @param {number} [timeoutMs] @returns {Promise<any>} */
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

  /** @param {string} method @param {unknown} [params] */
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Diagnostics the server last published for a document; undefined until it has published once. */
  /** @param {string} uri @returns {Diagnostic[] | undefined} */
  diagnosticsFor(uri) {
    return this.diagnostics.get(uri);
  }

  /** @param {string} uri */
  clearDiagnostics(uri) {
    this.diagnostics.delete(uri);
  }

  /** Handles a notification the server sends (not a publish): e.g. the Vue server's tsserver/request. @param {string} method @param {(params: any) => void} fn */
  onNotification(method, fn) {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(fn);
    this.notificationHandlers.set(method, list);
  }

  /** @param {string} uri @param {Listener} fn */
  listen(uri, fn) {
    const set = this.listeners.get(uri) ?? new Set();
    set.add(fn);
    this.listeners.set(uri, set);
  }

  /** @param {string} uri @param {Listener} fn */
  unlisten(uri, fn) {
    this.listeners.get(uri)?.delete(fn);
  }

  /**
   * The settled diagnostics for a document. Servers publish more than once per change: TypeScript sends an early list
   * (often empty) and the semantic list after it. So the first publish only starts the wait; the answer is the last
   * list once no publish has arrived for quietMs. If no publish comes within firstMs, a fallback (an edited document
   * the server did not republish) keeps its last known list; otherwise the wait fails.
   */
  /** @param {string} uri @param {{ firstMs: number, quietMs: number, fallback?: boolean }} opts @returns {Promise<Diagnostic[]>} */
  settledDiagnostics(uri, { firstMs, quietMs, fallback = false }) {
    return new Promise((resolve, reject) => {
      /** @type {Diagnostic[] | undefined} */
      let latest;
      let got = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let quiet;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let first;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let hard;
      /** @param {Error} [err] */
      const done = (err) => {
        clearTimeout(first);
        clearTimeout(quiet);
        clearTimeout(hard);
        this.unlisten(uri, onPublish);
        if (err) return reject(err);
        const out = latest ?? this.diagnostics.get(uri);
        // Never answer "clean" without a list from the server.
        if (out) resolve(out);
        else reject(new Error(`no diagnostics for ${uri}`));
      };
      /** @type {Listener} */
      const onPublish = (list, err) => {
        if (err) return done(err);
        got = true;
        latest = list;
        clearTimeout(quiet);
        quiet = setTimeout(() => done(), quietMs);
      };
      first = setTimeout(() => {
        if (got) return;
        if (fallback && this.diagnostics.has(uri)) return done();
        done(new Error(`no diagnostics for ${uri} in ${firstMs} ms`));
      }, firstMs);
      hard = setTimeout(() => done(got ? undefined : new Error(`no settled diagnostics for ${uri}`)), firstMs + 4 * quietMs);
      this.listen(uri, onPublish);
    });
  }

  /** @returns {Promise<void>} */
  async shutdown() {
    if (!this.child || this.exited) return;
    try {
      await this.request("shutdown", null, 5_000);
      this.notify("exit");
    } catch {
      /* the server may already be gone; the kill below still runs */
    }
    const child = this.child;
    await new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
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

  /** @param {object} msg */
  send(msg) {
    if (!this.child || this.exited) throw new Error("language server is not running");
    const body = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  /** @param {Buffer} chunk */
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

  /** @param {any} msg */
  dispatch(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      // Servers ask for their settings. Answer with the defaults an editor would send: null turns validation off in some servers.
      const result = msg.method === "workspace/configuration" ? (/** @type {{ section?: string }[]} */ (msg.params?.items ?? [])).map((item) => settingsFor(item.section)) : null;
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
    if (msg.method !== undefined) for (const fn of this.notificationHandlers.get(msg.method) ?? []) fn(msg.params);
    if (msg.method === "textDocument/publishDiagnostics") this.publishFrom("self", msg.params.uri, msg.params.diagnostics ?? []);
  }

  /**
   * Records a source's latest list for a document, and tells the waiters. A document's list is the union of its sources,
   * without duplicates: the Vue server's own list and the TypeScript companion's (which carries the template checks).
   * @param {string} source @param {string} uri @param {Diagnostic[]} list
   */
  publishFrom(source, uri, list) {
    const bySource = this.sources.get(uri) ?? new Map();
    bySource.set(source, list);
    this.sources.set(uri, bySource);
    const seen = new Set();
    /** @type {Diagnostic[]} */
    const all = [];
    for (const d of [...bySource.values()].flat()) {
      const key = `${d.range.start.line}:${d.range.start.character}|${d.range.end.line}:${d.range.end.character}|${d.code}|${d.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(d);
      }
    }
    this.diagnostics.set(uri, all);
    for (const fn of [...(this.listeners.get(uri) ?? [])]) fn(all);
  }

  /** @param {Error} err */
  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // A dead server answers nothing: every waiter fails, so a document is never reported clean by default.
    for (const [, set] of this.listeners) for (const fn of [...set]) fn(undefined, err);
    this.listeners.clear();
  }
}

/** Files under a project root, skipping dependencies and build output. Depth-limited so a repo scan stays fast. */
const SKIP = new Set(["node_modules", "dist", ".git", ".cloudflare", ".wrangler", "coverage", "__pycache__", ".venv", "venv"]);
/** @param {string} root @param {(name: string) => boolean} accept @param {{ depth?: number, limit?: number }} [opts] @returns {string[]} */
export function listFiles(root, accept, { depth = 6, limit = 2000 } = {}) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir @param {number} d */
  const walk = (dir, d) => {
    if (out.length >= limit) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // Dot-folders are part of the repo (.agents, .claude, .github, .githooks): only the SKIP names are left out.
      if (SKIP.has(name)) continue;
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

/** @param {string} root @param {string[]} names */
const hasFile = (root, names) => names.some((n) => existsSync(join(root, n)));
/** @param {string} p */
const extOf = (p) => extname(p).toLowerCase();
/** @param {...string} exts @returns {(name: string) => boolean} */
const extSet = (...exts) => (name) => exts.includes(extname(name).toLowerCase());

/** Finds a server binary: ours first, then PATH. */
/** @param {string} name */
export function binary(name) {
  const own = join(TOOLS_BIN, name);
  if (existsSync(own)) return own;
  return name;
}

/** The TypeScript library the language server reads: the project's own, else ours, else the global one. */
/** @param {string} root @returns {string | undefined} */
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
/** @type {Record<LangId, Language>} */
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
  vue: {
    label: "Vue",
    // Checked per project, like TypeScript: the server resolves 'vue' and the component types from the project's own
    // node_modules. Its TypeScript is the same one the TypeScript server reads.
    detect: (root) => listFiles(root, extSet(".vue"), { depth: 3, limit: 1 }).length > 0,
    files: (root) => listFiles(root, extSet(".vue")),
    languageId: (p) => (extOf(p) === ".vue" ? "vue" : undefined),
    spec(root) {
      const tsserver = resolveTsserver(root);
      if (!tsserver) return { missing: "no TypeScript found: install it in the project, or run `just setup`" };
      return { command: binary("vue-language-server"), args: ["--stdio"], initializationOptions: { typescript: { tsdk: dirname(tsserver) } } };
    },
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
/** Our tools folder: the Vue TypeScript plugin resolves from here. */
const VUE_PLUGIN = { name: "@vue/typescript-plugin", location: join(TOOLS_MODULES, ".."), languages: ["vue"] };

/** @param {LangId} lang @param {string} root @returns {Promise<Running | { missing: string }>} */
export async function startServer(lang, root) {
  if (lang === "vue") return startVue(root);
  return startPlain(lang, root, undefined);
}

/**
 * The Vue server does its TypeScript work through a TypeScript server that has the Vue plugin loaded. The client carries
 * its requests: each tsserver/request is run on that server (typescript.tsserverRequest) and answered with tsserver/response.
 * @param {string} root @returns {Promise<Running | { missing: string }>}
 */
async function startVue(root) {
  // The template checks type-check against the project's own vue. Without it, template expressions resolve to any and
  // pass silently, so a Vue project that does not install vue fails closed.
  try {
    createRequire(join(root, "package.json")).resolve("vue/package.json");
  } catch {
    return { missing: "vue is not installed in this project: run npm install (the template checks need its types)" };
  }
  const companion = await startPlain("typescript", root, { plugins: [VUE_PLUGIN] });
  if ("missing" in companion) return companion;
  const vue = await startPlain("vue", root, undefined);
  if ("missing" in vue) {
    await companion.client.shutdown();
    return vue;
  }
  // The server sends [[id, command, args]]: the request is the first parameter.
  vue.client.onNotification("tsserver/request", (/** @type {[[number, string, unknown]]} */ [[id, command, args]]) => {
    companion.client
      .request("workspace/executeCommand", { command: "typescript.tsserverRequest", arguments: [command, args, {}] }, 60_000)
      .then(
        (res) => vue.client.notify("tsserver/response", [[id, res?.body ?? null]]),
        () => vue.client.notify("tsserver/response", [[id, null]]),
      );
  });
  // The companion must see the same documents, or tsserver has no project for a .vue file.
  const notify = vue.client.notify.bind(vue.client);
  vue.client.notify = (/** @type {string} */ method, /** @type {unknown} */ params) => {
    notify(method, params);
    if (method.startsWith("textDocument/")) companion.client.notify(method, params);
  };
  // The companion's diagnostics for .vue documents are part of the Vue document's list.
  companion.client.onNotification("textDocument/publishDiagnostics", (/** @type {{ uri: string, diagnostics?: Diagnostic[] }} */ params) => {
    if (params.uri.endsWith(".vue")) vue.client.publishFrom("companion", params.uri, params.diagnostics ?? []);
  });
  const shutdown = vue.client.shutdown.bind(vue.client);
  vue.client.shutdown = async () => {
    await shutdown();
    await companion.client.shutdown();
  };
  return { ...vue, info: `${vue.info} + ${companion.info}` };
}

/** @param {LangId} lang @param {string} root @param {object | undefined} extraInit @returns {Promise<Running | { missing: string }>} */
async function startPlain(lang, root, extraInit) {
  const spec = LANGUAGES[lang].spec(root);
  if ("missing" in spec) return { missing: spec.missing };
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
      initializationOptions: { ...spec.initializationOptions, ...extraInit },
    },
    60_000,
  );
  client.notify("initialized", {});
  const name = init.serverInfo?.name ? `${init.serverInfo.name} ${init.serverInfo.version ?? ""}`.trim() : spec.command;
  return { client, info: name, versions: new Map(), lang };
}

/**
 * Opens a document, or sends its new text. Returns the URI and whether this call opened it.
 * Protocol (measured against typescript-language-server 6.1.0): a server publishes diagnostics when a document is opened,
 * and after an edit only when its diagnostics change. A save (textDocument/didSave) after a change makes it re-analyse.
 */
/** @param {Running} running @param {string} file @param {string} text @returns {{ uri: string, opened: boolean }} */
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
 * Diagnostics for the given documents, concurrently. A new document starts its wait with its first publish (up to
 * timeoutMs). An edited one starts it within settleMs; if the server does not republish, its diagnostics did not change,
 * so the last published list stands. Then every list is settled for QUIET_MS. Returns Map<file, Diagnostic[] | Error>.
 */
export const QUIET_MS = 4_000;
/**
 * Checks a set of documents on a running server, concurrently: every document is opened (or updated) first, then all
 * the answers are awaited together. `textFor(file)` gives the text to check (the staged text, or the working copy).
 * @param {Running} running @param {string[]} files @param {(file: string) => string} textFor
 * @returns {Promise<Map<string, Diagnostic[] | Error>>}
 */
export async function checkDocuments(running, files, textFor, timeoutMs = 15_000, settleMs = 1_500) {
  const pending = files.map((file) => {
    const text = textFor(file);
    const uri = pathToFileURL(file).href;
    const edited = running.versions.has(uri);
    const waiting = running.client.settledDiagnostics(uri, { firstMs: edited ? settleMs : timeoutMs, quietMs: QUIET_MS, fallback: edited });
    syncDocument(running, file, text);
    return waiting.then(
      (d) => /** @type {[string, Diagnostic[] | Error]} */ ([file, d]),
      (e) => /** @type {[string, Diagnostic[] | Error]} */ ([file, e]),
    );
  });
  return new Map(await Promise.all(pending));
}

export { basename, pathToFileURL };
