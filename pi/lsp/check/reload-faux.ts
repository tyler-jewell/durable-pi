// The scripted agent for the reload check: (1) lsp_diagnostics, (2) swap the installed extension for another build,
// (3) ask for a reload, and after it (4) lsp_diagnostics again. The reload is requested the way Pi documents: a tool
// records it and ends the run, and agent_settled runs the command that calls ctx.reload().
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerScripted, type Step } from "./scripted.ts";

const script: Step[] = [
  { tool: "lsp_diagnostics", args: { path: "src/app.ts" } },
  { tool: "bash", args: { command: `sh ${process.env.DPI_RELOAD_SWAP}` } },
  { tool: "reload_runtime", args: {} },
  { tool: "lsp_diagnostics", args: { path: "src/app.ts" } },
];

export default function (pi: ExtensionAPI) {
  registerScripted(pi, "reload-faux", (results) => script[results], "RELOAD_TEST_DONE");

  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  let reloadRequested = false;
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, themes, and context files",
    parameters: Type.Object({}),
    async execute() {
      reloadRequested = true;
      return { content: [{ type: "text", text: "Reload requested. Pi reloads after this response." }], details: {}, terminate: true };
    },
  });
  pi.on("agent_settled", () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true });
  });
}
