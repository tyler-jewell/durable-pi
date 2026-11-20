// Inspect a remote host's model-server setup over SSH: which llama-server processes are
// running (args, ports, model dir), whether any launchd service auto-starts them, and a live
// decision/LLM test against the host's HTTP endpoint. This is what turns "agents use MCP for
// 99% of their work" into reality — the agent asks for an inspection, it never hand-rolls ssh.
import { spawnSync } from "node:child_process";
import { meshFetch, runDecision, runLlm, type DecisionQuestion } from "./capabilities.js";

export interface HostProcess {
  pid: number;
  ppid: number;
  command: string;
}

export interface HostConfig {
  processes: HostProcess[];
  autoStartServices: string[]; // launchd plist paths that reference the model server
}

export interface HostTest {
  health: string;
  kind: "llm" | "decision";
  ms: number;
  sample?: string; // a sample answer, or undefined when the host had no model to test
}

/** One ssh round-trip that returns the host's model-server config as JSON. */
function sshJson(target: string): string {
  const script = [
    "import json, subprocess, glob, os",
    "out = {'processes': [], 'autoStartServices': [], 'error': None}",
    "try:",
    "    ps = subprocess.run(['ps','-eo','pid=,ppid=,command='], capture_output=True, text=True).stdout",
    "    for line in ps.splitlines():",
    "        if 'llama-server' in line or 'llama.cpp' in line:",
    "            out['processes'].append(line.strip())",
    "except Exception as e:",
    "    out['error'] = str(e)",
    "for p in [os.path.expanduser('~/Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']:",
    "    for f in glob.glob(os.path.join(p, '*.plist')):",
    "        try:",
    "            if 'llama' in open(f, encoding='utf-8', errors='ignore').read().lower():",
    "                out['autoStartServices'].append(f)",
    "        except Exception:",
    "            pass",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync(process.env.DPI_MCP_SSH ?? "ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "python3", "-c", `'${script.replace(/'/g, `'\\''`)}'`], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ssh ${target} failed: ${(r.stderr ?? r.stdout ?? "").trim().slice(0, 300)}`);
  return (r.stdout ?? "").trim();
}

/** Parse the remote JSON (processes + autoStartServices) into a HostConfig. */
export function parseHostConfig(json: string): HostConfig {
  const raw = JSON.parse(json) as { processes?: string[]; autoStartServices?: string[] };
  const processes: HostProcess[] = [];
  for (const line of raw.processes ?? []) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) processes.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return { processes, autoStartServices: raw.autoStartServices ?? [] };
}

/**
 * Inspect a host: SSH for its model-server config and launchd auto-start state, then run a
 * live test (a real decision or chat call) against its HTTP endpoint and time it.
 */
export async function inspectHost(
  target: string,
  address: string,
  models: { id: string; kind: "llm" | "decision" }[],
): Promise<{ config: HostConfig; test?: HostTest }> {
  const config = parseHostConfig(sshJson(target));
  const decision = models.find((m) => m.kind === "decision");
  const llm = models.find((m) => m.kind === "llm");
  const model = decision ?? llm;
  if (!model) return { config };

  const base = address.replace(/\/+$/, "");
  const t0 = Date.now();
  const health = await meshFetch(`${base}/health`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? "ok" : String(r.status))).catch((e) => `unreachable: ${String(e)}`);
  let sample: string | undefined;
  try {
    if (model.kind === "decision") {
      const question: Record<string, DecisionQuestion> = { probe: { type: "noul", instructions: "Return a value between 0 and 1." } };
      const r = await runDecision(base, model.id, {}, question);
      sample = JSON.stringify(r.answers.probe);
    } else {
      const r = await runLlm(base, model.id, [{ role: "user", content: "Reply with OK." }], { timeoutMs: 30_000 });
      sample = r.text;
    }
  } catch (e) {
    sample = `error: ${String((e as Error).message).slice(0, 120)}`;
  }
  return { config, test: { health, kind: model.kind, ms: Date.now() - t0, sample } };
}
