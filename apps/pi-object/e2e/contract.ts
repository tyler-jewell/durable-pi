// The e2e scenario, shared by both runs: the container (e2e/faux-agent.ts) and the Durable Object (src/index.ts).
// Same file, same content, same commit message, same turn order. Only the tool that commits differs: bash with git in
// the container, a git tool in the Worker.

export const E2E_FILE = "e2e/hello.txt";
export const E2E_CONTENT = "hello from the pi agent in a container\n";
export const SEED_MESSAGE = "e2e: seed";
export const SEED_README = "# e2e repo\n";
export const COMMIT_MESSAGE = "e2e: agent change";
export const DONE_MARKER = "E2E_AGENT_DONE";
export const AUTHOR = { name: "dpi-e2e", email: "e2e@dpi.invalid" };
export const BRANCH = "main";

export type Step = "write" | "push" | "done";

/** The scripted model's next move, from the last message. Write, then push, then finish. */
export function nextStep(last: { role: string; toolName?: string } | undefined): Step {
  if (last?.role === "toolResult" && last.toolName === "write") return "push";
  if (last?.role === "toolResult" && (last.toolName === "bash" || last.toolName === "git_commit_push")) return "done";
  return "write";
}
