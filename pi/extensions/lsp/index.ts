// Language servers for Pi agents. At session start, a server starts for each language the project calls for. Four tools
// query them, and the system prompt says what is running. An agent cannot bypass the git gate: commits that skip hooks
// are blocked before they run. The shared core is core.mjs; the gate is gate.mjs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES, SEVERITY, checkDocuments, startServer, syncDocument, killAllLiveServers } from "./core.mjs";
import type { Diagnostic, LangId, Running } from "./core.mjs";

const LANG_IDS = Object.keys(LANGUAGES) as LangId[];

// Servers stop when the process ends, however it ends.
process.once("exit", killAllLiveServers);
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    killAllLiveServers();
    process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
  });
}

// The same definition the eval scores: a commit or push that skips hooks, or a command that sets hooksPath to a value.
// Reading the hooks (git config --get core.hooksPath) is allowed. Blocked before they run; the gate is the only way in.
const BYPASS = /git\s+(commit|push)\b[^;&|]*--no-verify|git\s+(-c\s+core\.hooksPath=|config\s+(?!--get)(\S+\s+)*core\.hooksPath\s+[^\s|&;])|\bSKIP=/;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const MAX_FILES = 200;
const PER_FILE_JOBS = 3;

const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: s }], details });

/** Runs fn over items, at most n at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    }),
  );
}

export default function (pi: ExtensionAPI) {
  /** Servers started for the session, by language. A per-file language (Bash) has none here: see withServer. */
  const servers = new Map<LangId, Running>();
  const status = new Map<LangId, string>();
  let root = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    root = ctx.cwd;
    const detected = LANG_IDS.filter((lang) => LANGUAGES[lang].detect(root));
    // Start every detected server in parallel: session start waits for the slowest, not the sum. A per-file language
    // starts nothing here: its server is started for each file that is checked (withServer).
    await Promise.all(
      detected.map(async (lang) => {
        if (LANGUAGES[lang].perFile) {
          status.set(lang, "running per file (a server for each file, started when it is checked)");
          return;
        }
        try {
          const started = await startServer(lang, root);
          if ("missing" in started) {
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
      return { block: true, reason: "This would bypass the git gate. Leave hooks alone and commit normally: fix what the gate reports." };
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

  /** The language that covers a file. Refuses a file no language covers. */
  function langFor(abs: string): LangId {
    const lang = LANG_IDS.find((l) => LANGUAGES[l].languageId(abs) !== undefined);
    if (!lang) throw new Error(`no language server handles ${abs.split("/").pop()}`);
    return lang;
  }

  /**
   * Runs fn with a server for the file. Most languages share the session's server. A per-file language (Bash) gets its
   * own server for the file, started here and stopped after, because one Bash server answers only one document at a time.
   */
  async function withServer<R>(abs: string, fn: (running: Running) => Promise<R>): Promise<R> {
    const lang = langFor(abs);
    if (LANGUAGES[lang].perFile) {
      const started = await startServer(lang, root);
      if ("missing" in started) throw new Error(`no ${LANGUAGES[lang].label} server: ${started.missing}`);
      try {
        return await fn(started);
      } finally {
        await started.client.shutdown();
      }
    }
    const running = servers.get(lang);
    if (!running) throw new Error(`no ${LANGUAGES[lang].label} server running: ${status.get(lang) ?? "not configured in this project"}`);
    return fn(running);
  }

  const rel = (abs: string) => relative(root, abs) || abs.split("/").pop()!;
  const position = (line: number, column: number) => ({ line: Math.max(0, line - 1), character: Math.max(0, column - 1) });
  const locationText = (loc: { uri: string; range: { start: { line: number; character: number } } }) =>
    `${rel(fileURLToPath(loc.uri))}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;

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
      /** Every file to check, in the project or the one given. */
      const targets: string[] = params.path ? [inside(params.path)] : [];
      if (!params.path) {
        for (const lang of status.keys()) targets.push(...LANGUAGES[lang].files(root).slice(0, MAX_FILES));
      }
      if (targets.length === 0) return text("Nothing to check: no running language server covers these files.");
      const lines: string[] = [];
      let checked = 0;
      /** Checks one file (or the group that shares a server) and records what it found. */
      const record = (results: Map<string, Diagnostic[] | Error>, lang: LangId) => {
        for (const [abs, diags] of results) {
          checked += 1;
          if (!Array.isArray(diags)) {
            lines.push(`${rel(abs)}: could not check (${diags.message})`);
            continue;
          }
          for (const d of diags) {
            const code = d.code !== undefined ? ` [${d.source ?? lang} ${d.code}]` : "";
            lines.push(`${rel(abs)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[(d.severity ?? 1) - 1] ?? "error"}: ${d.message}${code}`);
          }
        }
      };
      const textOf = (f: string) => readFileSync(f, "utf8");
      // Shared-server files, grouped by language so each server checks its documents together.
      const shared = new Map<LangId, string[]>();
      // Per-file languages, one server per file, a few at a time.
      const perFile: Array<{ lang: LangId; abs: string }> = [];
      for (const abs of targets) {
        const lang = langFor(abs);
        if (LANGUAGES[lang].perFile) perFile.push({ lang, abs });
        else shared.set(lang, [...(shared.get(lang) ?? []), abs]);
      }
      await Promise.all([
        ...[...shared].map(async ([lang, files]) => {
          const running = servers.get(lang);
          if (!running) {
            lines.push(`${files.length} ${LANGUAGES[lang].label} file(s) not checked: ${status.get(lang) ?? "no server"}`);
            return;
          }
          record(await checkDocuments(running, files, textOf, DIAGNOSTIC_TIMEOUT_MS), lang);
        }),
        pool(perFile, PER_FILE_JOBS, async ({ lang, abs }) => {
          await withServer(abs, async (running) => record(await checkDocuments(running, [abs], textOf, DIAGNOSTIC_TIMEOUT_MS), lang)).catch((e: Error) => {
            lines.push(`${rel(abs)}: could not check (${e.message})`);
          });
        }),
      ]);
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
      return withServer(abs, async (running) => {
        const uri = syncDocument(running, abs, readFileSync(abs, "utf8")).uri;
        const result = await running.client.request("textDocument/definition", { textDocument: { uri }, position: position(params.line, params.column) });
        const locs = (Array.isArray(result) ? result : result ? [result] : []).map((l: any) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
        return text(locs.length ? locs.slice(0, 20).map(locationText).join("\n") : "No definition found.", { count: locs.length });
      });
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
      return withServer(abs, async (running) => {
        const uri = syncDocument(running, abs, readFileSync(abs, "utf8")).uri;
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
      });
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
      return withServer(abs, async (running) => {
        const uri = syncDocument(running, abs, readFileSync(abs, "utf8")).uri;
        const result = ((await running.client.request("textDocument/references", {
          textDocument: { uri },
          position: position(params.line, params.column),
          context: { includeDeclaration: true },
        })) ?? []) as any[];
        return text(result.length ? result.slice(0, 100).map(locationText).join("\n") : "No references found.", { count: result.length });
      });
    },
  });
}
