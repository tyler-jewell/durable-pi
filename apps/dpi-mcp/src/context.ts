// The context budget: a request must fit the window the server actually runs, not the window a model was trained
// with and not the one a config claims. The window is shared by the prompt and the output, so the budget is
// checked before a request is sent, and the output cap is clamped to what is left.
//
// Three numbers are kept apart, because mixing them up is what caused silent truncation:
//   served   what the server runs with (llama-server `--ctx-size`, a cloud catalog's context) — the budget uses this
//   trained  what the model was trained for (the models endpoint's `context_length`) — informational only
//   used     the tokens a request actually consumed (reported back)
import { createHash } from "node:crypto";

/** Fewest output tokens worth asking for. Below this the answer would be cut before it starts, so we refuse. */
export const MIN_OUTPUT_TOKENS = 256;

export class ContextBudgetError extends Error {
  readonly code = "context_exceeded";
  constructor(
    readonly windowTokens: number,
    readonly promptTokens: number,
  ) {
    super(
      `the prompt needs about ${promptTokens} tokens, and this model serves a ${windowTokens}-token window with room for ${Math.max(0, windowTokens - promptTokens)} output. Send less input, or enable a model with a larger served window.`,
    );
  }
}

/** The served window from llama-server's `--ctx-size N` (or `-c N`), in an argument list or a preset block. */
export function servedContextFromArgs(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^--ctx-size=(\d+)$/.exec(a);
    if (eq) return Number(eq[1]);
    if ((a === "--ctx-size" || a === "-c") && /^\d+$/.test(args[i + 1] ?? "")) return Number(args[i + 1]);
  }
  return undefined;
}

/** The served window from a llama-server preset (`ctx-size = N` lines). */
export function servedContextFromPreset(preset: string): number | undefined {
  const m = /^\s*ctx-size\s*=\s*(\d+)\s*$/m.exec(preset);
  return m ? Number(m[1]) : undefined;
}

/** The served window of one model entry from the router's models endpoint. Its `context_length` is trained, not served. */
export function servedContextOf(entry: { status?: { args?: unknown; preset?: unknown } }): number | undefined {
  const args = Array.isArray(entry.status?.args) ? (entry.status!.args as string[]) : [];
  const fromArgs = servedContextFromArgs(args);
  if (fromArgs !== undefined) return fromArgs;
  return typeof entry.status?.preset === "string" ? servedContextFromPreset(entry.status.preset) : undefined;
}

/** A conservative token estimate: about three characters per token, plus a few per message. It runs high on
 *  purpose, so an estimate never lets an oversized prompt through. */
export function estimateTokens(messages: { content: string }[] | string): number {
  if (typeof messages === "string") return Math.ceil(messages.length / 3);
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 3) + 4, 2);
}

export interface Budget {
  /** The output cap to send. Clamped to what the window leaves after the prompt. */
  maxTokens: number;
  /** False when the served window is unknown. The request then goes through unguarded, and the result says so. */
  guarded: boolean;
}

/** Decide the output cap for one request. Throws ContextBudgetError when the prompt alone leaves too little room. */
export function budget(windowTokens: number | undefined, promptTokens: number, requested: number): Budget {
  if (windowTokens === undefined) return { maxTokens: requested, guarded: false };
  const room = windowTokens - promptTokens;
  if (room < MIN_OUTPUT_TOKENS) throw new ContextBudgetError(windowTokens, promptTokens);
  return { maxTokens: Math.min(requested, room), guarded: true };
}

/** A short, stable fingerprint of a request's inputs, for the audit trail (never the content itself). */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
