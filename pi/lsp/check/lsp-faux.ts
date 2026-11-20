// The scripted agent for the LSP check: every language the fixture has, one project of each shape, an edit followed by a
// re-check, and a gate bypass.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerScripted, type Step } from "./scripted.ts";

const PROBE = `sh ${process.env.DPI_LSP_CHECK_DIR ?? "."}/probe.sh`;
const FIXED = "printf 'export function total(xs: number[]): number {\\n  return xs.reduce((a, b) => a + b, 0);\\n}\\n' > src/app.ts";

const script: Step[] = [
  { tool: "lsp_diagnostics", args: { path: "src/app.ts" } },
  { tool: "lsp_diagnostics", args: { path: "src/App.vue" } },
  { tool: "lsp_diagnostics", args: { path: "loose/src/loose.ts" } },
  { tool: "lsp_diagnostics", args: { path: "bad.json" } },
  { tool: "lsp_diagnostics", args: { path: "run.sh" } },
  { tool: "bash", args: { command: PROBE } },
  { tool: "lsp_definition", args: { path: "src/app.ts", line: 6, column: 30 } },
  { tool: "lsp_hover", args: { path: "src/app.ts", line: 6, column: 30 } },
  { tool: "bash", args: { command: FIXED } },
  { tool: "lsp_diagnostics", args: { path: "src/app.ts" } },
  { tool: "bash", args: { command: "git commit --no-verify -m bypass-attempt" } },
  { tool: "lsp_diagnostics", args: { path: `${process.env.DPI_LSP_CHECK_DIR}/outside.sh` } },
  { tool: "lsp_diagnostics", args: { path: "outside-link.sh" } },
  { tool: "lsp_diagnostics", args: { path: "ignored.sh" } },
  { tool: "lsp_diagnostics", args: { path: "node_modules/generated.sh" } },
  { tool: "lsp_diagnostics", args: { path: "scratch.sh" } },
  { tool: "lsp_diagnostics", args: { path: "scratch-link.sh" } },
  { tool: "lsp_hover", args: { path: "scratch.sh", line: 1, column: 1 } },
];

// The status the model was given: the language-servers section of its system prompt, one line per language. Pi shows the
// same status in the footer, which a print-mode run has no screen for, so the answer carries it for the check to read.
const statusLines = (systemPrompt: string) =>
  systemPrompt.split("\n").filter((l) => /^- [a-z-]+: (running \(\d+ files\)|failed )/.test(l)).join("\n");

export default function (pi: ExtensionAPI) {
  registerScripted(pi, "lsp-faux", (results) => script[results], (systemPrompt) => `LSP_TEST_DONE\n${statusLines(systemPrompt)}`);
}
