<script setup lang="ts">
import { computed, ref } from "vue";
import type { SystemStreamSource, SystemStreamView } from "@sdk/system-stream";

const props = defineProps<{ view: SystemStreamView }>();
const emit = defineEmits<{ changeSource: [source: SystemStreamSource] }>();

const sources: SystemStreamSource[] = ["local", "cloudflare"];
const filter = ref("");

const logs = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.view.logs;
  return props.view.logs.filter((l) => l.message.toLowerCase().includes(q) || l.level.includes(q));
});
</script>

<template>
  <div class="sys-stream" data-sys-stream>
    <div class="sys-stream__bar">
      <span class="sys-stream__title">System stream</span>
      <select
        :value="view.source"
        aria-label="Stream source"
        @change="emit('changeSource', ($event.target as HTMLSelectElement).value as SystemStreamSource)"
      >
        <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
      </select>
      <input v-model="filter" placeholder="filter logs…" aria-label="Filter logs" />
    </div>
    <ul v-if="view.events.length" class="sys-stream__events" aria-label="Events">
      <li
        v-for="e in view.events.slice(-12)"
        :key="`${e.at}-${e.kind}`"
        class="sys-event"
        :data-kind="e.kind"
      >
        {{ e.kind }}
      </li>
    </ul>
    <ol class="sys-stream__logs" aria-label="Logs">
      <li v-for="l in logs.slice(-200)" :key="l.at" class="sys-log" :data-level="l.level">
        {{ l.message }}
      </li>
    </ol>
  </div>
</template>

<style scoped>
.sys-stream {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.sys-stream__bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--base-app-border, #1f2937);
}
.sys-stream__title {
  font-weight: 600;
}
.sys-stream__bar input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid var(--base-app-border, #1f2937);
  color: inherit;
  padding: 4px 8px;
  border-radius: 6px;
}
.sys-stream__events {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  margin: 0;
  list-style: none;
  border-bottom: 1px solid var(--base-app-border, #1f2937);
}
.sys-event {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #1f2937;
}
.sys-stream__logs {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.sys-log {
  white-space: pre-wrap;
  word-break: break-word;
}
.sys-log[data-level="error"] {
  color: #f87171;
}
.sys-log[data-level="warn"] {
  color: #fbbf24;
}
.sys-log[data-level="debug"] {
  opacity: 0.6;
}
</style>
