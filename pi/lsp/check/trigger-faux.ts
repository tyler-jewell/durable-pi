// The custom-message run for the trigger check: after the first run settles, the extension starts a second run with
// pi.sendMessage(..., { triggerTurn: true }). That run has no prompt, so before_agent_start sees messageType "custom".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerScripted, type Step } from "./scripted.ts";

const script: Step[] = [{ tool: "lsp_diagnostics", args: { path: "src/app.ts" } }];

const statusLines = (systemPrompt: string) =>
  systemPrompt.split("\n").filter((l) => /^- [a-z-]+: (running \(\d+ files\)|failed )/.test(l)).join("\n");

export default function (pi: ExtensionAPI) {
  registerScripted(pi, "lsp-trigger", (results) => script[results], (systemPrompt) => `LSP_TRIGGER_DONE\n${statusLines(systemPrompt)}`);
  let triggered = false;
  pi.on("agent_settled", async () => {
    if (triggered) return;
    triggered = true;
    pi.sendMessage({ customType: "lsp-trigger", content: "Report the language-server status.", display: true }, { triggerTurn: true });
  });
}
