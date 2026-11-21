// Send one message to this machine's agent, the same call the composer makes. The token is read from the env file and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.DPI_HOME ?? join(homedir(), ".dpi");
const env: Record<string, string> = {};
for (const line of readFileSync(join(home, "backend.env"), "utf8").split("\n")) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) env[match[1]] = match[2];
}
const token = env.DPI_TOKEN;
const port = env.DPI_PORT || "4780";
const host = env.DPI_HOST || "127.0.0.1";
if (!token) throw new Error("DPI_TOKEN is missing from the device env file");
const content = process.argv.slice(2).join(" ").trim();
if (!content) throw new Error("usage: agent-send.mts <message>");

const base = `http://${host}:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const health = await fetch(`${base}/healthz`);
if (!health.ok) throw new Error(`device is not up (${health.status})`);

const device = await fetch(`${base}/v1/device`, { headers });
if (!device.ok) throw new Error(`device info failed (${device.status})`);
const info = (await device.json()) as { defaultModel?: string; models?: { provider: string; id: string }[]; startDirs?: string[] };
const model = info.models?.find((item) => item.id === info.defaultModel) ?? info.models?.[0];
if (!model) throw new Error("the device has no model");

const listed = await fetch(`${base}/v1/sessions`, { headers });
if (!listed.ok) throw new Error(`session list failed (${listed.status})`);
const sessions = (await listed.json()) as { name?: string }[] | { items?: { name?: string }[] };
const names = Array.isArray(sessions) ? sessions.map((item) => item.name) : (sessions.items ?? []).map((item) => item.name);
const session = names.find((name) => name && name !== "") ?? "main";
if (!names.includes(session)) {
  const created = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "main", cwd: info.startDirs?.[0] ?? ".", model: { provider: model.provider, modelId: model.id } }),
  });
  if (!created.ok) throw new Error(`session create failed (${created.status})`);
}

const sent = await fetch(`${base}/v1/sessions/${encodeURIComponent(session)}/agents/main/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({ content, requestId: `msg-${Date.now()}`, waitMs: 60_000 }),
});
const body = (await sent.json()) as { submissionId?: number; status?: string; answer?: { text?: string }; error?: string };
if (!sent.ok && sent.status !== 202) throw new Error(`send failed (${sent.status})`);
const text = body.answer?.text ?? (typeof body.error === "string" ? body.error : "");
console.log(`submission ${body.submissionId ?? "?"} status ${body.status ?? sent.status}`);
if (text) console.log(text);
