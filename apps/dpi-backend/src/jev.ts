// Provider-agnostic Jev client (TypeSafe System One). One call answers a few bounded questions about
// a JSON state in a few hundred milliseconds. The provider is resolved from the environment, so the
// same caller works against TypeSafe, OpenRouter, Cloudflare Workers AI, or any System One-compatible
// endpoint (for example a local llama.cpp router) without code changes: whichever credentials are
// present wins, and a `JEV_BASE_URL` override forces a specific endpoint.
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
}

interface JevTransport {
  readonly provider: string;
  readonly endpoint: string;
  readonly key?: string;
  readonly model: string;
  readonly headers?: Record<string, string>;
  payload(state: unknown, questions: Record<string, JevQuestion>): unknown;
  /** Unwrap the wire body into the System One `answers` record. */
  answers(body: unknown): Record<string, JevAnswer>;
}

const systemOne = (endpoint: string, model: string, key?: string): JevTransport => ({
  provider: "system-one",
  endpoint,
  key,
  model,
  payload: (state, questions) => ({ model, state, questions }),
  answers: (body) => (body as { answers?: Record<string, JevAnswer> }).answers ?? {},
});

/**
 * Cloudflare Workers AI wraps third-party System One models in its API envelope:
 * `{ success, result: { state: "Completed", result: { answers, usage } } }`. Cloudflare-hosted
 * models (e.g. clef) return the answers directly under `result`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 */
const cloudflare = (endpoint: string): JevTransport => ({
  provider: "cloudflare-workers-ai",
  endpoint,
  key: env("CLOUDFLARE_API_KEY"),
  model: env("JEV_MODEL") ?? "typesafe/jev",
  headers: { "cf-aig-gateway-id": env("CLOUDFLARE_GATEWAY_ID") ?? "default" },
  payload: (state, questions) => ({ model: env("JEV_MODEL") ?? "typesafe/jev", input: { state, questions } }),
  answers: (body) => {
    const b = body as { success?: boolean; result?: { state?: string; result?: { answers?: Record<string, JevAnswer> }; answers?: Record<string, JevAnswer> } };
    if (b.success === false) throw Error("Cloudflare Workers AI request failed");
    const result = b.result;
    if (!result || typeof result !== "object") throw Error("Cloudflare Workers AI returned an unexpected response");
    if (result.answers) return result.answers;
    if (result.state !== "Completed" || !result.result?.answers) throw Error("Cloudflare Workers AI run did not complete");
    return result.result.answers;
  },
});

/** First provider whose credentials are present wins. */
export function resolveTransport(): JevTransport {
  const base = env("JEV_BASE_URL");
  if (base) {
    const model = env("JEV_MODEL") ?? "jev-latest";
    return systemOne(base.replace(/\/+$/, ""), model, env("JEV_API_KEY"));
  }
  if (env("TYPESAFE_API_KEY")) {
    return systemOne("https://api.typesafe.ai/v1/systemone", "jev-latest", env("TYPESAFE_API_KEY"));
  }
  if (env("OPENROUTER_API_KEY")) {
    return systemOne("https://openrouter.ai/api/alpha/decisions", "~typesafe/jev-latest", env("OPENROUTER_API_KEY"));
  }
  if (env("CLOUDFLARE_API_KEY") && env("CLOUDFLARE_ACCOUNT_ID")) {
    return cloudflare(`https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}/ai/run`);
  }
  throw Error(
    "Jev needs TYPESAFE_API_KEY, OPENROUTER_API_KEY, CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID, or JEV_BASE_URL (with optional JEV_MODEL / JEV_API_KEY)",
  );
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  const transport = resolveTransport();
  const body = JSON.stringify(transport.payload(state, questions));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: {
        ...transport.headers,
        ...(transport.key ? { Authorization: `Bearer ${transport.key}` } : {}),
        "Content-Type": "application/json",
      },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Jev HTTP ${res.status} (${transport.provider})`);
    const data = (await res.json()) as unknown;
    const answers = transport.answers(data);
    for (const [id, q] of Object.entries(questions))
      if (answers[id]?.type !== q.type) throw Error(`Jev answer missing: ${id}`);
    return answers;
  }
}
