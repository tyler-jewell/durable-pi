// Deterministic agent for the LSP test: pi's real CLI and tools, with the model scripted.
// Turns: (1) check the language server process is running, (2) lsp_diagnostics on the planted error,
// (3) lsp_definition, (4) lsp_hover, (5) finish with a marker.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const PROBE = `sh ${process.env.DPI_LSP_CHECK_DIR ?? "."}/probe.sh`;

export default function (pi: ExtensionAPI) {
  const core = createFauxCore({ provider: "lsp-faux", models: [{ id: "scripted", name: "Scripted", contextWindow: 128000, maxTokens: 8192 }] });
  const turn = (context: { messages: unknown[] }) => {
    core.appendResponses([turn]);
    // Turns are keyed by how many tool results exist: there are two bash calls, so the name alone is not enough.
    const results = (context.messages as Array<{ role: string }>).filter((m) => m.role === "toolResult").length;
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage([fauxText(`calling ${name}`), fauxToolCall(name, args)], { stopReason: "toolUse" });
    switch (results) {
      case 0: return call("bash", { command: PROBE });
      case 1: return call("lsp_diagnostics", { path: "src/app.ts" });
      case 2: return call("lsp_definition", { path: "src/app.ts", line: 6, column: 30 });
      case 3: return call("lsp_hover", { path: "src/app.ts", line: 6, column: 30 });
      case 4: return call("bash", { command: "git commit --no-verify -m bypass-attempt" });
      default: return fauxAssistantMessage(fauxText("LSP_TEST_DONE"));
    }
  };
  core.setResponses([turn]);
  pi.registerProvider("lsp-faux", {
    baseUrl: "http://faux.invalid",
    apiKey: "faux",
    api: core.api,
    models: core.models.map((m) => ({ type: "chat" as const, id: m.id, name: m.name, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
    streamSimple: core.streamSimple,
  });
}
