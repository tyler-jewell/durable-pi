<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { AppShell } from "../index";
import SystemStream from "../stream/SystemStream.vue";
import { emptySystemStream, reduceSystemStream, type SystemStreamView } from "@sdk/system-stream";

const view = ref<SystemStreamView>(emptySystemStream());
view.value = reduceSystemStream(view.value, {
  type: "hello",
  source: "local",
  appId: "demo",
  startedAt: Date.now(),
});

let n = 0;
const tick = () => {
  n++;
  if (n % 5 === 0) {
    view.value = reduceSystemStream(view.value, {
      type: "event",
      at: Date.now(),
      kind: "job.phase",
      payload: { job: "release-check", phase: "approve" },
    });
  } else {
    view.value = reduceSystemStream(view.value, {
      type: "log",
      at: Date.now(),
      level: n % 17 === 0 ? "warn" : "info",
      message: `demo log line ${n}`,
    });
  }
};
const timer = setInterval(tick, 800);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <AppShell title="Base app" app-id="demo" status="live" model="@cf/meta/llama-3.3">
    <template #left>
      <div class="placeholder">Generated view + approval flow (left)</div>
    </template>
    <template #right>
      <SystemStream :view="view" />
    </template>
  </AppShell>
</template>

<style scoped>
.placeholder {
  padding: 16px;
  color: #9ca3af;
}
</style>
