// The right-panel "system stream": the DO streaming itself — its own logs plus structured UI
// events. Produced by the DO/backend, reduced by base-app into a renderable view. Logs are
// redacted server-side before they leave; events are typed and carry display-only fields, so the
// stream is safe-by-construction for a public app.

export type SystemStreamSource = "local" | "cloudflare";

export interface SystemStreamHello {
  type: "hello";
  source: SystemStreamSource;
  appId: string;
  startedAt: number;
}

export interface SystemStreamLog {
  type: "log";
  at: number;
  level: "debug" | "info" | "warn" | "error";
  /** Already redacted server-side. */
  message: string;
}

export interface SystemStreamEvent {
  type: "event";
  at: number;
  /** e.g. "agent.started", "job.phase", "approval.pending", "deploy.finished". */
  kind: string;
  /** Typed, display-only, safe fields. */
  payload: Record<string, string | number | boolean>;
}

export type SystemStreamFrame = SystemStreamHello | SystemStreamLog | SystemStreamEvent;

export interface SystemStreamView {
  source: SystemStreamSource;
  appId: string;
  /** Newest last, capped. */
  logs: SystemStreamLog[];
  /** Newest last, capped. */
  events: SystemStreamEvent[];
}

const MAX_LOGS = 1000;
const MAX_EVENTS = 500;

export function emptySystemStream(): SystemStreamView {
  return { source: "local", appId: "", logs: [], events: [] };
}

export function reduceSystemStream(view: SystemStreamView, frame: SystemStreamFrame): SystemStreamView {
  if (frame.type === "hello") return { ...view, source: frame.source, appId: frame.appId };
  if (frame.type === "log") return { ...view, logs: [...view.logs.slice(-(MAX_LOGS - 1)), frame] };
  return { ...view, events: [...view.events.slice(-(MAX_EVENTS - 1)), frame] };
}
