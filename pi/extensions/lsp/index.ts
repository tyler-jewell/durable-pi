// Language servers for Pi agents. At session start the checkout's file extensions decide which servers start: one per
// language, never more (see core.mjs). Four tools query them, and the system prompt says what is running. An agent cannot
// bypass the git gate: commits that skip hooks are blocked before they run.
//
// This file is only the Pi side. Everything about servers lives in core.mjs, which the git gate shares. install.sh
// installs core.mjs under a name that carries its content hash and points this file at it, so a /reload always runs the
// code that was installed, never a cached older copy.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, isToolCallEventType, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES, LSP_BUILD, SEVERITY, Workspace, langOf } from "./core.mjs";
import type { Diagnostic, LangId } from "./core.mjs";

// The same definition the eval scores: a commit or push that skips hooks, or a command that sets hooksPath to a value.
// Reading the hooks (git config --get core.hooksPath) is allowed. Blocked before they run; the gate is the only way in.
const BYPASS = /git\s+(commit|push)\b[^;&|]*--no-verify|git\s+(-c\s+core\.hooksPath=|config\s+(?!--get)(\S+\s+)*core\.hooksPath\s+[^\s|&;])|\bSKIP=/;
/** Files one project-wide check covers per language. A larger repo is checked in parts, by path. */
const MAX_FILES = 300;

/** The parts of LSP results this file reads. */
type Pos = { line: number; character: number };
type Location = { uri: string; range: { start: Pos } };
type LocationLink = { targetUri: string; targetSelectionRange?: { start: Pos }; targetRange: { start: Pos } };
type MarkedString = string | { value: string };
type Hover = { contents?: MarkedString | MarkedString[] } | null;

const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: s }], details: { build: LSP_BUILD, ...details } });
const truncate = (s: string, n = 120) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Output is cut to Pi's limits, with a note on how to see the rest. */
function limited(output: string): string {
  const cut = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!cut.truncated) return output;
  return `${cut.content}\n\n[Output truncated: ${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}). Run lsp_diagnostics with a path to see one file.]`;
}

export default function (pi: ExtensionAPI) {
  let ws: Workspace | undefined;
  let root = process.cwd();

  const workspace = (): Workspace => {
    if (!ws) throw new Error("language servers are not started in this session");
    return ws;
  };

  pi.on("session_start", async (_event, ctx) => {
    await ws?.shutdown();
    root = ctx.cwd;
    ws = new Workspace(root);
    for (const s of await ws.start()) {
      process.stderr.write(`[lsp] ${s.label}: ${s.state === "running" ? `running (${s.files} files)` : `failed ${truncate(s.message)}`}\n`);
    }
  });

  pi.on("session_shutdown", async () => {
    await ws?.shutdown();
    ws = undefined;
  });

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event) && BYPASS.test(event.input.command)) {
      return { block: true, reason: "This would bypass the git gate. Leave hooks alone and commit normally: fix what the gate reports." };
    }
  });

  pi.on("before_agent_start", async (event) => {
    const statuses = ws?.status() ?? [];
    if (statuses.length === 0) return;
    const lines = statuses.map((s) => `- ${s.label}: ${s.state === "running" ? `running (${s.files} files)` : `failed ${truncate(s.message)}`}`);
    // A diffable section, not a full prompt replacement: Pi patches only this section when it changes.
    event.systemPromptOptions.sections["language-servers"] =
      lines.join("\n") +
      "\nRun lsp_diagnostics only on supported, Git-tracked files inside this project that are not excluded. " +
      "For scratch shell scripts outside the project (for example under /tmp), use bash -n and, if installed, shellcheck instead. " +
      "Use lsp_definition, lsp_hover and lsp_references on project files to read types and find symbols instead of guessing. " +
      "Commits run a gate that rejects any error or warning these servers report, so fix them first.";
  });

  const trackedFile = (path: string) => workspace().toolPath(path);

  const rel = (abs: string) => relative(root, abs) || abs.split("/").pop()!;
  const position = (line: number, column: number) => ({ line: Math.max(0, line - 1), character: Math.max(0, column - 1) });
  const locationText = (loc: Location) => `${rel(fileURLToPath(loc.uri))}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  const asLocation = (l: Location | LocationLink): Location => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l);

  const positionParams = Type.Object({
    path: Type.String({ description: "Path to an eligible file inside the project" }),
    line: Type.Integer({ minimum: 1, description: "Line, starting at 1" }),
    column: Type.Integer({ minimum: 1, description: "Column, starting at 1" }),
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP diagnostics",
    description:
      "Errors and warnings for Git-tracked files inside the project. Omit the path to check tracked project files. For scratch shell scripts, use bash -n or shellcheck. Output is cut at 50KB / 2000 lines.",
    promptSnippet: "lsp_diagnostics: errors and warnings for a file, as the language server sees them",
    promptGuidelines: ["lsp_diagnostics: check edited files only if they are Git-tracked, supported, and in scope. Do not pass untracked scratch files."],
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Eligible file inside the project; omit to check the project" })) }),
    async execute(_id, params) {
      const w = workspace();
      let files: string[];
      if (params.path) {
        files = [trackedFile(params.path)];
        if (!langOf(files[0])) return text(`No language server covers ${rel(files[0])}.`);
      } else {
        files = [];
        for (const s of w.status()) if (s.state === "running") files.push(...(w.scan?.byLang.get(s.lang as LangId) ?? []).slice(0, MAX_FILES));
      }
      if (files.length === 0) return text("Nothing to check: no running language server covers these files.");
      // One file is being worked on: leave it open, as an editor does. A whole-project check closes what it opened.
      const results = await w.diagnostics(files, { keepOpen: Boolean(params.path) });
      const lines: string[] = [];
      for (const [abs, diags] of results) {
        if (!Array.isArray(diags)) {
          lines.push(`${rel(abs)}: could not check (${diags.message})`);
          continue;
        }
        for (const d of diags as Diagnostic[]) {
          const code = d.code !== undefined ? ` [${d.source ?? LANGUAGES[langOf(abs) as LangId].label} ${d.code}]` : "";
          lines.push(`${rel(abs)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[(d.severity ?? 1) - 1] ?? "error"}: ${d.message}${code}`);
        }
      }
      return text(limited(lines.length ? lines.join("\n") : `No diagnostics (${results.size} file(s) checked).`), { files: results.size, count: lines.length });
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
      const result: Location | LocationLink | Array<Location | LocationLink> | null = await workspace().query(params.path, "textDocument/definition", { position: position(params.line, params.column) });
      const locs = (Array.isArray(result) ? result : result ? [result] : []).map(asLocation);
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
      const result: Hover = await workspace().query(params.path, "textDocument/hover", { position: position(params.line, params.column) });
      const marked = (m: MarkedString) => (typeof m === "string" ? m : m.value);
      const contents = result?.contents;
      const body = !contents ? "" : Array.isArray(contents) ? contents.map(marked).join("\n\n") : marked(contents);
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
      const result: Location[] =
        (await workspace().query(params.path, "textDocument/references", {
          position: position(params.line, params.column),
          context: { includeDeclaration: true },
        })) ?? [];
      return text(result.length ? result.slice(0, 100).map(locationText).join("\n") : "No references found.", { count: result.length });
    },
  });
}
