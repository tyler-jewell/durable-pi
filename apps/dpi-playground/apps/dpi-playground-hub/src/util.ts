/** Shared hub helpers: the JSON error envelope and an abortable delay. */

export const err = (code: string, message: string) => ({ error: { code, message } });

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
