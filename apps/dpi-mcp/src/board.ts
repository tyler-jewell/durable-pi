// A board message is how work is requested. It is a device message, not an issue or a pull request.
export async function sendBoard(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv, content: string): Promise<{ status: number; text: string }> {
  const home = env.DPI_HOME;
  if (!home) throw new Error("DPI_HOME is required");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file: Record<string, string> = {};
  for (const line of readFileSync(join(home, "backend.env"), "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) file[match[1]] = match[2];
  }
  const token = file.DPI_TOKEN;
  if (!token) throw new Error("DPI_TOKEN is missing from the device env file");
  const base = `http://${file.DPI_HOST || "127.0.0.1"}:${file.DPI_PORT || "4780"}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const sent = await fetchImpl(`${base}/v1/sessions/board-proof/agents/main/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: `board-${Date.now()}`, waitMs: 0 }),
  });
  const body = (await sent.json()) as { status?: string; error?: string };
  return { status: sent.status, text: body.error ?? body.status ?? "" };
}
