// The durable pi object: one PiAgent Durable Object per agent. It owns a Workspace (SQLite
// filesystem + a worker shell), runs the pi-ai agent loop against DeepSeek, and keeps its
// files across requests and restarts. Derived from cloudflare/computer examples/pi-ai.
//
//   client ──► Worker fetch ──► PiAgent DO ──► Workspace (files + shell)
//                                    └──► DeepSeek (deepseek-flash), key from a secret

import { DurableObject } from "cloudflare:workers";

import { Workspace, WorkspaceServiceProxy, type WorkspaceStub } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

// The worker-shell backend reaches back into this durable object by binding name and id, so
// the shell shares the agent's filesystem.
export { WorkspaceServiceProxy };

const PROVIDER_ID = "deepseek";
const MODEL_ID = "deepseek-flash";
// Bound the spend if the model fails to converge.
const MAX_TURNS = 10;

const SYSTEM_PROMPT =
  "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did.";

export class PiAgent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "PiAgent", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
    ],
  });

  /** Lets the shell in the Dynamic Worker reach this workspace. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  /** Read a file from this agent's workspace (for inspection and tests). */
  async read(path: string): Promise<string> {
    return this.workspace.fs.readFile(path, "utf8");
  }

  async run(task: string): Promise<{ answer: string; toolCalls: number; turns: number }> {
    const { tools, execute } = createPiTools({ workspace: this.workspace });

    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = models.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error(`model ${MODEL_ID} is not registered`);

    const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
    // The key travels with each request as pi's per-request env; it is never stored in the DO.
    const env = { DEEPSEEK_API_KEY: this.env.DEEPSEEK_API_KEY };

    let toolCalls = 0;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const reply = await models.complete(model, { systemPrompt: SYSTEM_PROMPT, messages, tools }, { env });
      messages.push(reply);

      const calls = reply.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) {
        const answer = reply.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        return { answer, toolCalls, turns: turn + 1 };
      }

      for (const call of calls) {
        toolCalls += 1;
        const { content, isError } = await execute(call);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError,
          timestamp: Date.now(),
        });
      }
    }

    return { answer: `Gave up after ${MAX_TURNS} turns.`, toolCalls, turns: MAX_TURNS };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed: every route needs the device token, so a public URL cannot spend the model key.
    if (!env.DPI_TOKEN) return new Response("DPI_TOKEN is not set\n", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${env.DPI_TOKEN}`) {
      return new Response("unauthorized\n", { status: 401 });
    }

    const url = new URL(request.url);
    // One agent per name; the demo uses a single agent. Use ?agent=<name> to address another.
    const agent = env.PiAgent.get(env.PiAgent.idFromName(url.searchParams.get("agent") ?? "demo"));

    if (request.method === "GET" && url.pathname === "/file") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("path is required\n", { status: 400 });
      try {
        return new Response(await agent.read(path));
      } catch {
        return new Response("not found\n", { status: 404 });
      }
    }

    if (request.method === "POST") {
      const { task } = (await request.json()) as { task?: string };
      if (!task) return new Response("body needs a task\n", { status: 400 });
      return Response.json(await agent.run(task));
    }

    return new Response('POST {"task": "..."} to run, GET /file?path=/workspace/x to read\n', { status: 405 });
  },
} satisfies ExportedHandler<Env>;
