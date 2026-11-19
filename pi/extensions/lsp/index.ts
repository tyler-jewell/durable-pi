// Language servers for Pi agents. At session start, a server starts for each language the project calls for. Four tools
// query them, and the system prompt says what is running. An agent cannot bypass the git gate: commits that skip hooks
// are blocked before they run. The shared core is core.mjs; the gate is gate.mjs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LANGUAGES, SEVERITY, checkDocuments, startServer, syncDocument, killAllLiveServers } from "./core.mjs";

// Servers stop when the process ends, however it ends.
process.once("exit", killAllLiveServers);
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    killAllLiveServers();
    process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
  });
}

/** Commands that would skip the git gate. Blocked before they run; the gate itself is the only way in. */
const BYPASS = /--no-verify|core\.hooksPath|hooksPath|\bSKIP=|\bgit\s+-c\s+core\./;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const MAX_FILES = 200;

const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: s }], details });

export default function (pi: ExtensionAPI) {
  /** Started servers, by language id. Each is the object core.mjs's startServer returned. */
  const servers = new Map<string, any>();
  const status = new Map<string, string>();
  let root = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    root = ctx.cwd;
    const detected = Object.keys(LANGUAGES).filter((lang) => LANGUAGES[lang].detect(root));
    // Start every detected server in parallel: session start waits for the slowest, not the sum.
    await Promise.all(
      detected.map(async (lang) => {
        try {
          const started = await startServer(lang, root);
          if (started.missing) {
            status.set(lang, `not running: ${started.missing}`);
          } else {
            servers.set(lang, started);
            status.set(lang, `running (${started.info}, pid ${started.client.pid})`);
          }
        } catch (e) {
          status.set(lang, `not running: ${(e as Error).message}`);
        }
      }),
    );
    for (const lang of detected) process.stderr.write(`[lsp] ${lang}: ${status.get(lang)}\n`);
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...servers.values()].map((s) => s.client.shutdown()));
    servers.clear();
    status.clear();
  });

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event) && BYPASS.test(event.input.command)) {
      return { block: true, reason: "This command would skip the git gate (hooks). Commit without skipping hooks; fix what the gate reports." };
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (status.size === 0) return;
    const lines = [...status].map(([lang, s]) => `- ${LANGUAGES[lang].label}: ${s}`);
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n<language-servers>\n" +
        lines.join("\n") +
        "\nAfter you edit a file of a language listed above, run lsp_diagnostics on it before you report the change done. " +
        "Use lsp_definition, lsp_hover and lsp_references to read types and find symbols instead of guessing. " +
        "Commits run a gate that rejects any error or warning these servers report, so fix them first.\n</language-servers>",
    };
  });

  /** An absolute path inside the project. Anything outside it is refused. */
  function inside(path: string): string {
    const abs = isAbsolute(path) ? path : resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path must be inside the project: ${path}`);
    return abs;
  }

  /** The running server for a file's language. Refuses a file no language covers, and says why when its server is down. */
  function serverFor(abs: string): any {
    const lang = Object.keys(LANGUAGES).find((l) => LANGUAGES[l].languageId(abs) !== undefined);
    if (!lang) throw new Error(`no language server handles ${abs.split("/").pop()}`);
    const running = servers.get(lang);
    if (!running) throw new Error(`no ${LANGUAGES[lang].label} server running: ${status.get(lang) ?? "not configured in this project"}`);
    return running;
  }

  const rel = (abs: string) => relative(root, abs) || abs.split("/").pop()!;
  const position = (line: number, column: number) => ({ line: Math.max(0, line - 1), character: Math.max(0, column - 1) });
  const locationText = (loc: { uri: string; range: { start: { line: number; character: number } } }) =>
    `${rel(fileURLToPath(loc.uri))}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;

  /** Syncs one file with the working copy's text and returns its URI. Does not wait for diagnostics. */
  function syncOne(running: any, abs: string): string {
    return syncDocument(running, abs, readFileSync(abs, "utf8")).uri;
  }

  const positionParams = Type.Object({
    path: Type.String({ description: "File path, relative to the project" }),
    line: Type.Integer({ minimum: 1, description: "Line, starting at 1" }),
    column: Type.Integer({ minimum: 1, description: "Column, starting at 1" }),
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP diagnostics",
    description:
      "Errors and warnings from the language servers. With a path, checks that file. Without one, checks the project's files for every running language, concurrently.",
    promptSnippet: "lsp_diagnostics: errors and warnings for a file, as the language server sees them",
    promptGuidelines: ["lsp_diagnostics: run it on each file you edited, before you report the change done."],
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "File to check; omit to check the project" })) }),
    async execute(_id, params) {
      const targets: Array<{ running: any; abs: string }> = [];
      if (params.path) {
        const abs = inside(params.path);
        targets.push({ running: serverFor(abs), abs });
      } else {
        for (const [lang, running] of servers) {
          for (const abs of LANGUAGES[lang].files(root).slice(0, MAX_FILES)) targets.push({ running, abs });
        }
      }
      if (targets.length === 0) return text("Nothing to check: no running language server covers these files.");
      // Group by server, then check each server's documents together.
      const byServer = new Map<any, string[]>();
      for (const t of targets) byServer.set(t.running, [...(byServer.get(t.running) ?? []), t.abs]);
      const lines: string[] = [];
      let checked = 0;
      await Promise.all(
        [...byServer].map(async ([running, files]: [any, string[]]) => {
          const results = await checkDocuments(running, files, (f) => readFileSync(f, "utf8"), DIAGNOSTIC_TIMEOUT_MS);
          for (const [abs, diags] of results) {
            checked += 1;
            if (!Array.isArray(diags)) {
              lines.push(`${rel(abs)}: could not check (${(diags as Error).message})`);
              continue;
            }
            for (const d of diags as any[]) {
              const code = d.code !== undefined ? ` [${d.source ?? running.lang} ${d.code}]` : "";
              lines.push(`${rel(abs)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[(d.severity ?? 1) - 1] ?? "error"}: ${d.message}${code}`);
            }
          }
        }),
      );
      return text(lines.length ? lines.join("\n") : `No diagnostics (${checked} file(s) checked).`, { files: checked, count: lines.length });
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP definition",
    description: "Where a symbol is defined, from the language server. Line and column start at 1.",
    promptSnippet: "lsp_definition: go to the definition of the symbol at a position",
    promptGuidelines: ["lsp_definition: use it to find where a function, type or variable is declared before you change it."],
    parameters: positionParams,
    async execute(_id, params) {
      const abs = inside(params.path);
      const running = serverFor(abs);
      const uri = syncOne(running, abs);
      const result = await running.client.request("textDocument/definition", { textDocument: { uri }, position: position(params.line, params.column) });
      const locs = (Array.isArray(result) ? result : result ? [result] : []).map((l: any) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
      return text(locs.length ? locs.slice(0, 20).map(locationText).join("\n") : "No definition found.", { count: locs.length });
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP hover",
    description: "The type and documentation of the symbol at a position, from the language server. Line and column start at 1.",
    promptSnippet: "lsp_hover: the type of the symbol at a position",
    promptGuidelines: ["lsp_hover: use it to check a symbol's type before you call or change it."],
    parameters: positionParams,
    async execute(_id, params) {
      const abs = inside(params.path);
      const running = serverFor(abs);
      const uri = syncOne(running, abs);
      const result = (await running.client.request("textDocument/hover", { textDocument: { uri }, position: position(params.line, params.column) })) as any;
      const contents = result?.contents;
      const body = !contents
        ? ""
        : typeof contents === "string"
          ? contents
          : Array.isArray(contents)
            ? contents.map((c: any) => (typeof c === "string" ? c : c.value)).join("\n\n")
            : contents.value;
      return text(body || "No type information here.");
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP references",
    description: "Every reference to the symbol at a position, from the language server. Line and column start at 1.",
    promptSnippet: "lsp_references: every use of the symbol at a position",
    promptGuidelines: ["lsp_references: use it to find all callers before you change a function's signature."],
    parameters: positionParams,
    async execute(_id, params) {
      const abs = inside(params.path);
      const running = serverFor(abs);
      const uri = syncOne(running, abs);
      const result = ((await running.client.request("textDocument/references", {
        textDocument: { uri },
        position: position(params.line, params.column),
        context: { includeDeclaration: true },
      })) ?? []) as any[];
      return text(result.length ? result.slice(0, 100).map(locationText).join("\n") : "No references found.", { count: result.length });
    },
  });
}
