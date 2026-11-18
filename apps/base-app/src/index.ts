// The canonical Durable Object app shell. Every DO app imports this and fills in its own
// left-panel generated views + approval flow; the right-panel system stream and the chrome
// (top bar, nav rail, footer) are shared. The stream contract and the `redact()` hygiene helper
// live in @sdk so the backend and the UI agree on them.
export { default as AppShell } from "./shell/AppShell.vue";
export { default as NavRail } from "./shell/NavRail.vue";
export type { NavItem } from "./shell/NavRail.vue";
export { default as SystemStream } from "./stream/SystemStream.vue";
export { default as StateEditor } from "./left/StateEditor.vue";
export { default as JobCard } from "./left/JobCard.vue";
export { default as Transcript } from "./left/Transcript.vue";
export { default as TranscriptItem } from "./left/TranscriptItem.vue";
export { redact, REDACTED } from "@sdk/redact";
export {
  emptySystemStream,
  reduceSystemStream,
  type SystemStreamEvent,
  type SystemStreamFrame,
  type SystemStreamHello,
  type SystemStreamLog,
  type SystemStreamSource,
  type SystemStreamView,
} from "@sdk/system-stream";

export type { CostReadout } from "./shell/cost";
