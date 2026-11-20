// A scripted model for the session tests: pi's real CLI and tools, with the model replaced by a function of how many
// tool results the conversation holds so far. Registered as a provider named after the test that uses it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

type Args = Parameters<typeof fauxToolCall>[1];
/** What the model does at a step: call a tool, or (undefined) finish with the given text. */
export type Step = { tool: string; args: Args } | undefined;

/** `doneText` is the final answer, or a function of the system prompt the model was given. */
export function registerScripted(pi: ExtensionAPI, provider: string, step: (results: number) => Step, doneText: string | ((systemPrompt: string) => string)): void {
  const core = createFauxCore({ provider, models: [{ id: "scripted", name: "Scripted", contextWindow: 128000, maxTokens: 8192 }] });
  const turn = (context: { messages: unknown[] }) => {
    core.appendResponses([turn]);
    const results = (context.messages as Array<{ role: string }>).filter((m) => m.role === "toolResult").length;
    const next = step(results);
    if (!next) return fauxAssistantMessage(fauxText(typeof doneText === "function" ? doneText(getCurrentSystemPrompt(context.messages as Parameters<typeof getCurrentSystemPrompt>[0])) : doneText));
    return fauxAssistantMessage([fauxText(`calling ${next.tool}`), fauxToolCall(next.tool, next.args)], { stopReason: "toolUse" });
  };
  core.setResponses([turn]);
  pi.registerProvider(provider, {
    baseUrl: "http://faux.invalid",
    apiKey: "faux",
    api: core.api,
    models: core.models.map((m) => ({ type: "chat" as const, id: m.id, name: m.name, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
    streamSimple: core.streamSimple,
  });
}
