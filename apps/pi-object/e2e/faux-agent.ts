// Deterministic agent for the e2e run. The pi CLI and its real tools run unchanged; only the model is scripted,
// so a run needs no network model and every step is the same on every run.
//
// Turns: (1) write a file, (2) commit and push it through pi's bash tool, (3) finish with a marker.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export const PROVIDER = "e2e-faux";
export const E2E_FILE = "e2e/hello.txt";
export const E2E_CONTENT = "hello from the pi agent in a container\n";
export const COMMIT_MESSAGE = "e2e: agent change";
export const DONE_MARKER = "E2E_AGENT_DONE";
const PUSH = `git add -A && git -c user.name=dpi-e2e -c user.email=e2e@dpi.invalid commit -q -m "${COMMIT_MESSAGE}" && git push -q origin HEAD:main && echo "PUSHED_SHA=$(git rev-parse HEAD)"`;

interface Msg {
  role: string;
  toolName?: string;
}

export default function (pi: ExtensionAPI) {
  const core = createFauxCore({
    provider: PROVIDER,
    models: [{ id: "scripted", name: "Scripted", contextWindow: 128000, maxTokens: 8192 }],
  });
  // A factory re-queues itself, so every request gets the next scripted turn (same pattern as the backend's faux).
  const turn = (context: { messages: unknown[] }) => {
    core.appendResponses([turn]);
    const last = (context.messages as Msg[]).at(-1);
    if (last?.role === "toolResult" && last.toolName === "write")
      return fauxAssistantMessage([fauxText("Committing and pushing."), fauxToolCall("bash", { command: PUSH })], { stopReason: "toolUse" });
    if (last?.role === "toolResult" && last.toolName === "bash")
      return fauxAssistantMessage(fauxText(`${DONE_MARKER} ${E2E_FILE}`));
    return fauxAssistantMessage([fauxText("Writing the file."), fauxToolCall("write", { path: E2E_FILE, content: E2E_CONTENT })], {
      stopReason: "toolUse",
    });
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
