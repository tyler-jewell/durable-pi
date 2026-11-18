// Phase B: the same agent loop as run-local.mjs, but the model is real.
// The model comes from pi's ModelRuntime, which reads credentials from
// ~/.pi/agent/auth.json (the same login `pi` uses). Nothing is scripted.
//
//   npm run real            # defaults to anthropic/claude-haiku-5-5
//   PI_MODEL_ID=... npm run real

import { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER = process.env.PI_PROVIDER ?? "anthropic";
const MODEL_ID = process.env.PI_MODEL_ID ?? "claude-haiku-5-5";
const MAX_TURNS = 10;
const TASK = "Write a haiku about durable objects to /workspace/haiku.txt, then read it back and tell me what you wrote.";

const runtime = await ModelRuntime.create();
const model = runtime.getModel(PROVIDER, MODEL_ID);
if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} is not in the catalog`);

const workspace = new Workspace({ storage: new SQLiteTestStorage() });
const { tools, execute } = createPiTools({ workspace });

const messages = [{ role: "user", content: TASK, timestamp: Date.now() }];
let answer = "(no answer)";
let toolCalls = 0;
const started = Date.now();

for (let turn = 0; turn < MAX_TURNS; turn += 1) {
  const reply = await runtime.complete(model, {
    systemPrompt: "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did.",
    messages,
    tools,
  });
  messages.push(reply);

  const calls = reply.content.filter((block) => block.type === "toolCall");
  if (calls.length === 0) {
    answer = reply.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    break;
  }
  for (const call of calls) {
    toolCalls += 1;
    const { content, isError } = await execute(call);
    console.log(`turn ${turn}: ${call.name}(${JSON.stringify(call.arguments).slice(0, 80)}) isError=${isError}`);
    messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, timestamp: Date.now() });
  }
}

console.log(`\nmodel: ${PROVIDER}/${MODEL_ID}  turns: ${messages.filter((m) => m.role === "assistant").length}  tool calls: ${toolCalls}  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("answer:", answer.trim());
const onDisk = await workspace.fs.readFile("/workspace/haiku.txt", "utf8").catch(() => undefined);
console.log("file on disk:", JSON.stringify(onDisk));
await workspace.close?.();
