// The language-server core, shared by the pi extension (index.ts) and the git gate (gate.mjs). Plain JavaScript with Node
// built-ins only, so the hook needs nothing installed beyond node and the servers.
//
// The model, in four rules:
//
//  1. A workspace is one repository checkout (for a Durable Object app: the app's repo). Its servers run beside the
//     checkout, never inside the Durable Object: a Worker cannot spawn a process.
//  2. The files decide the servers. scanWorkspace() lists every file's extension; the extension table (LANGUAGES) maps
//     each extension to a language; a server starts for every language that has files, and for no other.
//  3. One server per language per workspace, never more. The TypeScript server finds each file's own tsconfig, so a
//     monorepo with twenty projects still has one. The registry is a Map keyed by language, and starts are memoised.
//  4. No timers decide an answer. TypeScript is asked directly (tsserver's *DiagnosticsSync commands). JSON, CSS and
//     HTML are asked with LSP pull diagnostics. Bash, Python and Vue publish, and a publish counts only when it carries
//     the version of the text we sent.
//
// Every server started by this process is killed when the process exits, so none outlives its agent or hook.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** The build this core was installed as. install.sh and the reload test change it to tell two installs apart. */
export const LSP_BUILD = "dev";

/** @typedef {{ line: number, character: number }} Position */
/** @typedef {{ start: Position, end: Position }} Range */
/** @typedef {{ range: Range, severity?: number, code?: string | number, source?: string, message: string }} Diagnostic */
/** @typedef {"typescript" | "vue" | "json" | "css" | "html" | "bash" | "python"} LangId */
/** @typedef {"tsserver" | "vue" | "pull" | "push"} Strategy */
/** @typedef {{ command: string, args: string[], initializationOptions?: object }} ServerSpec */
/** @typedef {{ label: string, strategy: Strategy, ids: Record<string, string> }} Language */
/** @typedef {{ lang: LangId, label: string, state: "running" | "failed", message: string, files: number }} Status */
/** @typedef {{ start: { line: number, offset: number }, end: { line: number, offset: number }, text: string, code?: number, category?: string, reportsUnnecessary?: boolean, reportsDeprecated?: boolean }} TsDiagnostic */
/** @typedef {{ files: string[], extensions: Map<string, number>, byLang: Map<LangId, string[]> }} Scan */

/** Our own install of the servers (pi/lsp/install.sh). Preferred over anything on PATH. */
export const TOOLS_BIN = join(homedir(), ".dpi", "lsp-tools", "node_modules", ".bin");
const TOOLS_MODULES = join(homedir(), ".dpi", "lsp-tools", "node_modules");

// ---------------------------------------------------------------------------------------------------------------------
// The extension table: which language owns which file extension, and how its answers are obtained.
// ---------------------------------------------------------------------------------------------------------------------

/** @type {Record<LangId, Language>} */
export const LANGUAGES = {
  typescript: {
    label: "typescript",
    strategy: "tsserver",
    ids: { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" },
  },
  vue: { label: "vue", strategy: "vue", ids: { ".vue": "vue" } },
  json: { label: "json", strategy: "pull", ids: { ".json": "json", ".jsonc": "jsonc" } },
  css: { label: "css", strategy: "pull", ids: { ".css": "css" } },
  html: { label: "html", strategy: "pull", ids: { ".html": "html" } },
  bash: { label: "bash", strategy: "push", ids: { ".sh": "shellscript" } },
  python: { label: "python", strategy: "push", ids: { ".py": "python" } },
};

/** @type {LangId[]} */
export const LANG_IDS = /** @type {LangId[]} */ (Object.keys(LANGUAGES));
export const SEVERITY = ["error", "warning", "information", "hint"];

/** @type {Map<string, { lang: LangId, id: string }>} */
const BY_EXTENSION = new Map();
for (const lang of LANG_IDS) for (const [ext, id] of Object.entries(LANGUAGES[lang].ids)) BY_EXTENSION.set(ext, { lang, id });

/** The language that owns a file, by its extension; undefined when no server covers it. @param {string} file */
export function langOf(file) {
  return BY_EXTENSION.get(extname(file).toLowerCase())?.lang;
}

/** The LSP language id of a file. @param {string} file */
export function languageIdOf(file) {
  return BY_EXTENSION.get(extname(file).toLowerCase())?.id;
}

// ---------------------------------------------------------------------------------------------------------------------
// The project: which files exist, and which of them a server should check.
// ---------------------------------------------------------------------------------------------------------------------

/** Directories no scan enters when git cannot list the files. */
const SKIP = new Set(["node_modules", "dist", ".git", ".cloudflare", ".wrangler", "coverage", "__pycache__", ".venv", "venv"]);

/** Repo-declared exclusions (pi/lsp/gate-exclude.txt): path prefixes the servers do not check, each with a reason. @param {string} root @returns {string[]} */
export function excludedPaths(root) {
  try {
    return readFileSync(join(root, "pi", "lsp", "gate-exclude.txt"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** @param {string} p */
const isFile = (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** Every file of a checkout. Git knows best (tracked and untracked, minus .gitignore); a folder that is not a repo is walked. @param {string} root @returns {string[]} */
export function listProjectFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean).map((p) => join(root, p)).filter(isFile);
  } catch {
    /** @type {string[]} */
    const files = [];
    /** @param {string} dir @param {number} depth */
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        if (e.isDirectory()) {
          if (depth < 12) walk(join(dir, e.name), depth + 1);
        } else if (e.isFile()) files.push(join(dir, e.name));
      }
    };
    walk(root, 0);
    return files;
  }
}

/**
 * Lists the checkout's files and counts them by extension. `byLang` holds the files a server covers (minus the repo's
 * declared exclusions); `extensions` counts every extension, served or not.
 * @param {string} root @param {string[]} [exclude] @returns {Scan}
 */
export function scanWorkspace(root, exclude = excludedPaths(root)) {
  const files = listProjectFiles(root).filter((f) => !exclude.some((prefix) => relative(root, f).startsWith(prefix)));
  /** @type {Map<string, number>} */
  const extensions = new Map();
  /** @type {Map<LangId, string[]>} */
  const byLang = new Map();
  for (const f of files) {
    const ext = extname(f).toLowerCase() || "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    const lang = langOf(f);
    if (lang) byLang.set(lang, [...(byLang.get(lang) ?? []), f]);
  }
  return { files, extensions, byLang };
}

/** The languages a scan calls for, in table order. Vue needs the TypeScript server (its plugin does the type checks). @param {Scan} scan @returns {LangId[]} */
export function planLanguages(scan) {
  const want = new Set(scan.byLang.keys());
  if (want.has("vue")) want.add("typescript");
  return LANG_IDS.filter((l) => want.has(l));
}

/** A readable table of a scan: each extension, its count, and the language that serves it. @param {Scan} scan @returns {string[]} */
export function describeScan(scan) {
  const rows = [...scan.extensions].sort((a, b) => b[1] - a[1]);
  return rows.map(([ext, n]) => `${ext.padEnd(10)} ${String(n).padStart(6)}  ${BY_EXTENSION.get(ext)?.lang ?? "(no server)"}`);
}

/** Nearest directory at or above a file that holds a tsconfig or jsconfig; undefined when none. Used to group a check by project. @param {string} root @param {string} abs */
export function projectOf(root, abs) {
  let dir = dirname(abs);
  while (dir === root || dir.startsWith(root + "/")) {
    if (existsSync(join(dir, "tsconfig.json")) || existsSync(join(dir, "jsconfig.json"))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Server processes
// ---------------------------------------------------------------------------------------------------------------------

/** Every server this process started, shared across module generations so a /reload never leaves one behind. */
const GLOBAL = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
const LIVE_KEY = Symbol.for("dpi.lsp.live");
/** @type {Set<import("node:child_process").ChildProcess>} */
const live = /** @type {Set<import("node:child_process").ChildProcess>} */ (GLOBAL[LIVE_KEY] ??= new Set());

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
const EXIT_KEY = Symbol.for("dpi.lsp.exitHook");
if (!GLOBAL[EXIT_KEY]) {
  GLOBAL[EXIT_KEY] = true;
  process.once("exit", killAllLiveServers);
}

/** Default settings a server asks for, by section. Validation is on everywhere. @param {string | undefined} section */
export function settingsFor(section) {
  if (section === "css" || section === "scss" || section === "less") return { validate: true, lint: {}, completion: {}, hover: {} };
  if (section === "json") return { validate: true, allowComments: true, schemas: [] };
  return {};
}

/** JSON-RPC 2.0 over stdio with Content-Length framing. Answers the server's own requests neutrally, so a server never waits on us. */
export class LspClient {
  /** @param {string} command @param {string[]} args @param {string} cwd */
  constructor(command, args, cwd) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
    this.child = undefined;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map();
    /** @type {Map<string, Array<(params: any) => void>>} */
    this.notificationHandlers = new Map();
    /** The last publish per document that carried a version. @type {Map<string, { version: number, diagnostics: Diagnostic[] }>} */
    this.published = new Map();
    /** @type {Map<string, Set<{ version: number, resolve: (d: Diagnostic[]) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>>} */
    this.waiters = new Map();
    this.buffer = Buffer.alloc(0);
    this.exited = false;
  }

  /** @returns {number | undefined} */
  get pid() {
    return this.child?.pid;
  }

  start() {
    const child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    live.add(child);
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", () => {
      /* drained so a chatty server never blocks on a full pipe */
    });
    child.stdin.on("error", () => {
      /* the server is gone; its exit event fails the waiters */
    });
    child.on("exit", (code) => {
      live.delete(child);
      this.exited = true;
      this.failAll(new Error(`language server exited (code ${code})`));
    });
    child.on("error", (e) => {
      this.exited = true;
      this.failAll(e);
    });
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
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(/** @type {Error} */ (e));
      }
    });
  }

  /** @param {string} method @param {unknown} [params] */
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Handles a notification the server sends: a publish, or the Vue server's tsserver/request. @param {string} method @param {(params: any) => void} fn */
  onNotification(method, fn) {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(fn);
    this.notificationHandlers.set(method, list);
  }

  /**
   * The diagnostics a server published for a document at this version or later. A publish without a version, or for an
   * older one, is not an answer about the text we sent, so it never resolves this. Fails when no matching publish
   * arrives in time: a document is never reported clean on silence.
   * @param {string} uri @param {number} version @param {number} timeoutMs @returns {Promise<Diagnostic[]>}
   */
  waitForPublish(uri, version, timeoutMs) {
    const have = this.published.get(uri);
    if (have && have.version >= version) return Promise.resolve(have.diagnostics);
    return new Promise((resolve, reject) => {
      const set = this.waiters.get(uri) ?? new Set();
      this.waiters.set(uri, set);
      const waiter = {
        version,
        resolve,
        reject,
        timer: setTimeout(() => {
          set.delete(waiter);
          reject(new Error(`no diagnostics for ${basename(uri)} (version ${version}) in ${timeoutMs} ms`));
        }, timeoutMs),
      };
      set.add(waiter);
    });
  }

  /** @param {string} uri */
  forget(uri) {
    this.published.delete(uri);
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
      // A request from the server. Settings get the defaults an editor would send (null turns validation off in some servers).
      const result = msg.method === "workspace/configuration" ? (/** @type {{ section?: string }[]} */ (msg.params?.items ?? [])).map((item) => settingsFor(item.section)) : null;
      try {
        this.send({ jsonrpc: "2.0", id: msg.id, result });
      } catch {
        /* the server is gone */
      }
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
    if (msg.method === "textDocument/publishDiagnostics") this.onPublish(msg.params);
    if (msg.method !== undefined) for (const fn of this.notificationHandlers.get(msg.method) ?? []) fn(msg.params);
  }

  /** @param {{ uri: string, version?: number, diagnostics?: Diagnostic[] }} params */
  onPublish({ uri, version, diagnostics = [] }) {
    if (version === undefined) return;
    this.published.set(uri, { version, diagnostics });
    const set = this.waiters.get(uri);
    if (!set) return;
    for (const w of [...set]) {
      if (version < w.version) continue;
      clearTimeout(w.timer);
      set.delete(w);
      w.resolve(diagnostics);
    }
  }

  /** @param {Error} err */
  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // A dead server answers nothing: every waiter fails, so a document is never reported clean by default.
    for (const [, set] of this.waiters) {
      for (const w of set) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      set.clear();
    }
  }
}

/** Finds a server binary: ours first, then PATH. @param {string} name */
export function binary(name) {
  const own = join(TOOLS_BIN, name);
  return existsSync(own) ? own : name;
}

/** The TypeScript library the language server reads: the project's own, else ours, else the global one. @param {string} root @returns {string | undefined} */
export function resolveTsserver(root) {
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/lib/tsserver.js");
  } catch {
    /* not in the project, or a version without tsserver (TypeScript 7 is native) */
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

/** The heap the TypeScript server may use, in MB. It is the one process whose memory grows with the project. */
const TS_MEMORY_MB = Number(process.env.DPI_LSP_TS_MEMORY_MB ?? 1536);
/** How long a published answer, or a request, may take before the document counts as unchecked. */
const ANSWER_MS = 20_000;

/** The Vue plugin for the TypeScript server: it teaches tsserver .vue files, and type-checks their templates. */
const VUE_PLUGIN = { name: "@vue/typescript-plugin", location: join(TOOLS_MODULES, ".."), languages: ["vue"] };

/**
 * How to start a language's server for a workspace.
 * @param {LangId} lang @param {string} root @param {boolean} withVue
 * @returns {ServerSpec}
 */
function specFor(lang, root, withVue) {
  const override = process.env[`DPI_LSP_${lang.toUpperCase()}_COMMAND`];
  const tsserver = resolveTsserver(root);
  /** @type {ServerSpec} */
  let spec;
  switch (lang) {
    case "typescript":
      if (!tsserver) throw new Error("no TypeScript found: install it in the project, or run `just setup`");
      spec = {
        command: binary("typescript-language-server"),
        args: ["--stdio"],
        initializationOptions: {
          // One process (no separate syntax server), no npm run for type acquisition, and a ceiling on the heap.
          tsserver: { path: tsserver, useSyntaxServer: "never" },
          disableAutomaticTypingAcquisition: true,
          maxTsServerMemory: TS_MEMORY_MB,
          ...(withVue ? { plugins: [VUE_PLUGIN] } : {}),
        },
      };
      break;
    case "vue":
      if (!tsserver) throw new Error("no TypeScript found: install it in the project, or run `just setup`");
      spec = { command: binary("vue-language-server"), args: ["--stdio"], initializationOptions: { typescript: { tsdk: dirname(tsserver) } } };
      break;
    case "json":
      spec = { command: binary("vscode-json-language-server"), args: ["--stdio"] };
      break;
    case "css":
      spec = { command: binary("vscode-css-language-server"), args: ["--stdio"] };
      break;
    case "html":
      spec = { command: binary("vscode-html-language-server"), args: ["--stdio"] };
      break;
    case "bash":
      // Without this the server scans the whole workspace (node_modules included) in the background before answering.
      spec = { command: binary("bash-language-server"), args: ["start"], initializationOptions: { backgroundAnalysisMaxFiles: 0 } };
      break;
    case "python":
      spec = { command: binary("pyright-langserver"), args: ["--stdio"] };
      break;
  }
  return override ? { ...spec, command: override } : spec;
}

/**
 * One language server process for one workspace: start, restart, the documents it has open, and a lane so that only one
 * request that needs the server to itself runs at a time (the Bash and Vue servers answer one document at a time).
 */
class LanguageServer {
  /** @param {LangId} lang @param {string} root @param {() => ServerSpec} specFn */
  constructor(lang, root, specFn) {
    this.lang = lang;
    this.root = root;
    this.specFn = specFn;
    /** @type {LspClient} */
    this.client = new LspClient("", [], root);
    /** Versions only go up, across close and reopen, so a stale publish can never match a newer text. @type {Map<string, number>} */
    this.counter = new Map();
    /** @type {Set<string>} */
    this.open = new Set();
    /** @type {Promise<unknown>} */
    this.lane = Promise.resolve();
  }

  get alive() {
    return !this.client.exited;
  }

  async start() {
    const spec = this.specFn();
    this.client = new LspClient(spec.command, spec.args, this.root);
    this.open.clear();
    this.client.start();
    const rootUri = pathToFileURL(this.root).href;
    await this.client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            diagnostic: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        initializationOptions: spec.initializationOptions,
      },
      60_000,
    );
    this.client.notify("initialized", {});
  }

  async restart() {
    await this.client.shutdown().catch(() => {});
    this.counter.clear();
    await this.start();
  }

  /** Runs fn when every earlier use of the lane is done. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  exclusive(fn) {
    const run = this.lane.then(fn, fn);
    this.lane = run.catch(() => {});
    return run;
  }

  /**
   * Opens a document, or sends its new text. Returns its URI and the version of this text.
   * @param {string} file @param {string} text @returns {{ uri: string, version: number }}
   */
  sync(file, text) {
    const uri = pathToFileURL(file).href;
    const version = (this.counter.get(uri) ?? 0) + 1;
    this.counter.set(uri, version);
    if (this.open.has(uri)) {
      this.client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    } else {
      this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageIdOf(file), version, text } });
      this.open.add(uri);
    }
    return { uri, version };
  }

  /** @param {string} file */
  close(file) {
    const uri = pathToFileURL(file).href;
    if (!this.open.has(uri) || !this.alive) return;
    this.open.delete(uri);
    this.client.forget(uri);
    try {
      this.client.notify("textDocument/didClose", { textDocument: { uri } });
    } catch {
      /* the server just exited */
    }
  }

  async shutdown() {
    await this.client.shutdown();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// tsserver answers (TypeScript, JavaScript, and the type checks of Vue files)
// ---------------------------------------------------------------------------------------------------------------------

/** One tsserver command, through the TypeScript language server. Returns the response body. @param {LanguageServer} s @param {string} command @param {object} args @returns {Promise<any>} */
async function tsRequest(s, command, args) {
  const res = await s.client.request("workspace/executeCommand", { command: "typescript.tsserverRequest", arguments: [command, args, {}] }, 120_000);
  if (res && res.success === false) throw new Error(`tsserver ${command}: ${res.message ?? "failed"}`);
  return res?.body;
}

/** @param {string | undefined} category */
const tsSeverity = (category) => (category === "error" ? 1 : category === "warning" ? 2 : category === "suggestion" ? 4 : 3);

/** @param {TsDiagnostic} d @returns {Diagnostic} */
function fromTs(d) {
  return {
    range: { start: { line: d.start.line - 1, character: d.start.offset - 1 }, end: { line: d.end.line - 1, character: d.end.offset - 1 } },
    severity: tsSeverity(d.category),
    code: d.code,
    source: "typescript",
    message: d.text,
  };
}

/**
 * Everything the TypeScript server says about one open document, by asking it: syntax, types, and suggestions (hints).
 * A file no tsconfig includes is a finding in itself: tsserver would check it with default settings, which is no check.
 * @param {LanguageServer} s @param {string} file @returns {Promise<Diagnostic[] | Error>}
 */
async function tsDiagnostics(s, file) {
  const info = await tsRequest(s, "projectInfo", { file, needFileNameList: false });
  const config = /** @type {string | undefined} */ (info?.configFileName);
  if (!config || config.includes("/inferredProject")) {
    return new Error("no tsconfig.json or jsconfig.json includes this file; add it to the `include` of the folder's tsconfig");
  }
  const [syntactic, semantic, suggestion] = await Promise.all(["syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync"].map((c) => tsRequest(s, c, { file })));
  // As an editor does: a suggestion is shown only when it marks code as unused or deprecated. The rest ("may be
  // converted to an async function") are refactoring offers, not findings.
  const hints = /** @type {TsDiagnostic[]} */ (suggestion ?? []).filter((d) => d.reportsUnnecessary || d.reportsDeprecated);
  return /** @type {TsDiagnostic[]} */ ([...(syntactic ?? []), ...(semantic ?? []), ...hints]).map(fromTs);
}

// ---------------------------------------------------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------------------------------------------------

/** One repository checkout and the language servers its files call for: one per language, never more. */
export class Workspace {
  /** @param {string} root @param {{ exclude?: string[] }} [options] */
  constructor(root, options = {}) {
    this.root = root;
    this.exclude = options.exclude ?? excludedPaths(root);
    /** One server per language. A second never starts: see #start. @type {Map<LangId, LanguageServer>} */
    this.servers = new Map();
    /** @type {Map<LangId, Promise<void>>} */
    this.starting = new Map();
    /** @type {Map<LangId, Status>} */
    this.statuses = new Map();
    /** @type {Scan | undefined} */
    this.scan = undefined;
    this.withVue = false;
  }

  /**
   * Scans the files and starts the server of every language that has some (or of the given languages). Never throws:
   * a server that fails to start is reported as failed, and its files are reported as unchecked.
   * @param {LangId[]} [only] @returns {Promise<Status[]>}
   */
  async start(only) {
    this.scan = scanWorkspace(this.root, this.exclude);
    const planned = [...(only ?? planLanguages(this.scan))];
    if (planned.includes("vue") && !planned.includes("typescript")) planned.push("typescript");
    this.withVue = planned.includes("vue");
    const ts = planned.includes("typescript") ? this.#start("typescript") : undefined;
    const others = planned.filter((l) => l !== "typescript" && l !== "vue").map((l) => this.#start(l));
    // Vue's server asks the TypeScript server for types, so it starts once that one is up.
    const vue = planned.includes("vue")
      ? (async () => {
          await ts;
          if (this.servers.has("typescript")) await this.#start("vue");
          else this.#fail("vue", "needs the typescript server, which is not running");
        })()
      : undefined;
    await Promise.all([ts, ...others, vue]);
    return this.status();
  }

  /** @returns {Status[]} */
  status() {
    return LANG_IDS.filter((l) => this.statuses.has(l)).map((l) => /** @type {Status} */ (this.statuses.get(l)));
  }

  /** @param {LangId} lang @param {string} message */
  #fail(lang, message) {
    this.statuses.set(lang, { lang, label: LANGUAGES[lang].label, state: "failed", message, files: this.scan?.byLang.get(lang)?.length ?? 0 });
  }

  /** The only place a server is created. Memoised per language, so asking twice never starts two. @param {LangId} lang @returns {Promise<void>} */
  #start(lang) {
    const existing = this.starting.get(lang);
    if (existing) return existing;
    const run = (async () => {
      const server = new LanguageServer(lang, this.root, () => specFor(lang, this.root, this.withVue));
      try {
        await server.start();
        this.servers.set(lang, server);
        if (lang === "vue") this.#bridgeVue(server);
        this.statuses.set(lang, { lang, label: LANGUAGES[lang].label, state: "running", message: "", files: this.scan?.byLang.get(lang)?.length ?? 0 });
      } catch (e) {
        await server.client.shutdown().catch(() => {});
        this.#fail(lang, /** @type {Error} */ (e).message);
      }
    })();
    this.starting.set(lang, run);
    return run;
  }

  /** The Vue server does its TypeScript work through the TypeScript server: each tsserver/request it sends is run there and answered. @param {LanguageServer} vue */
  #bridgeVue(vue) {
    vue.client.onNotification("tsserver/request", (/** @type {[[number, string, unknown]]} */ [[id, command, args]]) => {
      const ts = this.servers.get("typescript");
      const answer = ts
        ? tsRequest(ts, command, /** @type {object} */ (args)).catch(() => null)
        : Promise.resolve(null);
      answer.then((body) => {
        try {
          vue.client.notify("tsserver/response", [[id, body ?? null]]);
        } catch {
          /* the Vue server exited */
        }
      });
    });
  }

  /** How many server processes the workspace holds per language, to prove the rule: one each. @returns {Record<string, number>} */
  serverCounts() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [lang, s] of this.servers) out[lang] = s.alive ? 1 : 0;
    return out;
  }

  /** @param {LangId} lang @returns {LanguageServer} */
  #running(lang) {
    const s = this.servers.get(lang);
    if (!s) throw new Error(`${LANGUAGES[lang].label} server is not running${this.statuses.get(lang)?.message ? `: ${this.statuses.get(lang)?.message}` : ""}`);
    return s;
  }

  /**
   * Runs fn against a language's server. A server that died (the TypeScript server does when it outgrows its heap) is
   * restarted once and fn is run again; a second death is an error.
   * @template T @param {LangId} lang @param {(s: LanguageServer) => Promise<T>} fn @returns {Promise<T>}
   */
  async #run(lang, fn) {
    for (const l of /** @type {LangId[]} */ (lang === "vue" ? ["typescript", "vue"] : [lang])) {
      const s = this.#running(l);
      if (!s.alive) await s.restart();
    }
    const s = this.#running(lang);
    try {
      return await fn(s);
    } catch (e) {
      if (s.alive) throw e;
      await s.restart();
      return await fn(s);
    }
  }

  /**
   * The diagnostics for files, as `file -> list | Error`. An Error means the file could not be checked, which the caller
   * must treat as a failure, never as clean. Languages run in parallel; within a language files go one at a time.
   * `textFor` gives the text to check (staged text, or the working copy). Unless `keepOpen`, the documents opened for the
   * check are closed afterwards, so the TypeScript server can let go of projects nobody is using.
   * @param {string[]} files @param {{ textFor?: (file: string) => string, keepOpen?: boolean }} [options]
   * @returns {Promise<Map<string, Diagnostic[] | Error>>}
   */
  async diagnostics(files, options = {}) {
    const textFor = options.textFor ?? ((/** @type {string} */ f) => readFileSync(f, "utf8"));
    const keepOpen = options.keepOpen ?? false;
    /** @type {Map<string, Diagnostic[] | Error>} */
    const out = new Map();
    /** @type {Map<LangId, string[]>} */
    const byLang = new Map();
    for (const f of files) {
      const lang = langOf(f);
      if (!lang) out.set(f, new Error("no language server covers this file type"));
      else byLang.set(lang, [...(byLang.get(lang) ?? []), f]);
    }
    await Promise.all(
      [...byLang].map(async ([lang, group]) => {
        try {
          await this.#run(lang, (s) => this.#diagnose(lang, s, group, textFor, keepOpen, out));
        } catch (e) {
          for (const f of group) if (!out.has(f)) out.set(f, /** @type {Error} */ (e));
        }
      }),
    );
    return out;
  }

  /** @param {LangId} lang @param {LanguageServer} s @param {string[]} files @param {(f: string) => string} textFor @param {boolean} keepOpen @param {Map<string, Diagnostic[] | Error>} out */
  async #diagnose(lang, s, files, textFor, keepOpen, out) {
    switch (LANGUAGES[lang].strategy) {
      case "tsserver":
      case "vue":
        return this.#diagnoseTs(lang, s, files, textFor, keepOpen, out);
      case "pull":
        for (const f of files) {
          const { uri } = s.sync(f, textFor(f));
          try {
            const res = await s.client.request("textDocument/diagnostic", { textDocument: { uri } }, ANSWER_MS);
            out.set(f, res?.kind === "full" ? res.items : []);
          } catch (e) {
            out.set(f, /** @type {Error} */ (e));
          } finally {
            s.close(f);
          }
        }
        return;
      case "push":
        for (const f of files) out.set(f, await s.exclusive(() => this.#publishFor(s, f, textFor(f))));
        return;
    }
  }

  /** Sends one document to a publishing server and waits for the answer to exactly this text. @param {LanguageServer} s @param {string} file @param {string} text @returns {Promise<Diagnostic[] | Error>} */
  async #publishFor(s, file, text) {
    const { uri, version } = s.sync(file, text);
    try {
      return await s.client.waitForPublish(uri, version, ANSWER_MS);
    } catch (e) {
      return /** @type {Error} */ (e);
    } finally {
      s.close(file);
    }
  }

  /**
   * TypeScript, JavaScript and Vue files, a project at a time: the TypeScript server holds one project in memory, and
   * lets it go when the project's documents are closed. A Vue file is also sent to the Vue server, whose answers
   * (template syntax, v-for) are added to the type checks.
   * @param {LangId} lang @param {LanguageServer} s @param {string[]} files @param {(f: string) => string} textFor @param {boolean} keepOpen @param {Map<string, Diagnostic[] | Error>} out
   */
  async #diagnoseTs(lang, s, files, textFor, keepOpen, out) {
    const ts = lang === "vue" ? this.#running("typescript") : s;
    /** @type {Map<string, string[]>} */
    const byProject = new Map();
    for (const f of files) {
      const key = projectOf(this.root, f) ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), f]);
    }
    for (const group of byProject.values()) {
      try {
        for (const f of group) ts.sync(f, textFor(f));
        for (const f of group) {
          if (lang === "vue" && !this.#hasVue(f)) {
            out.set(f, new Error("vue is not installed for this file: run npm install (the template checks need its types)"));
            continue;
          }
          try {
            const typed = await tsDiagnostics(ts, f);
            if (typed instanceof Error || lang !== "vue") {
              out.set(f, typed);
              continue;
            }
            const template = await s.exclusive(() => this.#publishFor(s, f, textFor(f)));
            out.set(f, template instanceof Error ? template : [...typed, ...template]);
          } catch (e) {
            out.set(f, /** @type {Error} */ (e));
          }
        }
      } finally {
        if (!keepOpen) for (const f of group) ts.close(f);
      }
    }
  }

  /** Whether `vue` resolves from the file's folder. Without it template expressions are `any` and pass silently, so such a file fails. @param {string} file */
  #hasVue(file) {
    try {
      createRequire(join(dirname(file), "x.js")).resolve("vue/package.json");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One LSP request about a position (definition, hover, references). The document stays open afterwards, as in an editor.
   * @param {string} file @param {string} method @param {object} extra @returns {Promise<any>}
   */
  async query(file, method, extra) {
    const lang = langOf(file);
    if (!lang) throw new Error(`no language server covers ${basename(file)}`);
    return this.#run(lang, async (s) => {
      const text = readFileSync(file, "utf8");
      if (lang === "vue") this.#running("typescript").sync(file, text);
      const { uri } = s.sync(file, text);
      return s.client.request(method, { textDocument: { uri }, ...extra }, 30_000);
    });
  }

  async shutdown() {
    await Promise.all([...this.servers.values()].map((s) => s.shutdown()));
    this.servers.clear();
    this.starting.clear();
    this.statuses.clear();
  }
}
