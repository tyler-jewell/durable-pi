// Container side of the e2e: pi's real CLI and tools, with the model scripted (see contract.ts). The push is a bash
// `git` command, the container's equivalent of the Worker's git tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AUTHOR, BRANCH, COMMIT_MESSAGE, DONE_MARKER, E2E_CONTENT, E2E_FILE, nextStep } from "./contract.ts";

export const PROVIDER = "e2e-faux";
const PUSH = `git add -A && git -c user.name=${AUTHOR.name} -c user.email=${AUTHOR.email} commit -q -m "${COMMIT_MESSAGE}" && git push -q origin HEAD:${BRANCH} && echo "PUSHED_SHA=$(git rev-parse HEAD)"`;

export default function (pi: ExtensionAPI) {
  const core = createFauxCore({
    provider: PROVIDER,
    models: [{ id: "scripted", name: "Scripted", contextWindow: 128000, maxTokens: 8192 }],
  });
  // A factory re-queues itself, so every request gets the next scripted turn (same pattern as the backend's faux).
  const turn = (context: { messages: unknown[] }) => {
    core.appendResponses([turn]);
    const last = context.messages.at(-1) as { role: string; toolName?: string } | undefined;
    switch (nextStep(last)) {
      case "push":
        return fauxAssistantMessage([fauxText("Committing and pushing."), fauxToolCall("bash", { command: PUSH })], { stopReason: "toolUse" });
      case "done":
        return fauxAssistantMessage(fauxText(`${DONE_MARKER} ${E2E_FILE}`));
      default:
        return fauxAssistantMessage([fauxText("Writing the file."), fauxToolCall("write", { path: E2E_FILE, content: E2E_CONTENT })], {
          stopReason: "toolUse",
        });
    }
  };
  core.setResponses([turn]);

  pi.registerProvider(PROVIDER, {
    // Required by pi for custom models. The scripted stream never calls it.
    baseUrl: "http://faux.invalid",
    // Placeholder, not a secret: pi requires a key for custom providers, the scripted stream never sends one.
    apiKey: "faux",
    api: core.api,
    models: core.models.map((m) => ({
      type: "chat" as const,
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    streamSimple: core.streamSimple,
  });
}
