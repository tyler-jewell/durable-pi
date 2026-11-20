<script setup lang="ts">
// The canonical layout: top bar · nav rail · left (generated view + approval) · right (the DO
// streaming itself) · footer. Identity comes from props; content comes from named slots.
import type { CostReadout } from "./cost";
import { pushAvailable, registerPushWorker } from "./push";

const props = defineProps<{
  title: string;
  appId?: string;
  status?: string;
  model?: string;
  /** One entry per cost object from the project's /v1/cost report. */
  costs?: CostReadout[];
}>();
const emit = defineEmits<{ toggleFreeTier: [id: string, enabled: boolean] }>();
const enableNotifications = () => {
  void registerPushWorker();
};

const costText = (c: CostReadout) => {
  if (c.usd !== null) return `${c.freeTier ? "free-tier assumed" : "list"} ${c.usd.toFixed(2)}`;
  return c.status === "unconfigured" ? "top-up not set" : c.status;
};
</script>

<template>
  <div class="base-app" data-base-app>
    <header class="base-app__topbar">
      <strong class="base-app__title">{{ title }}</strong>
      <span v-if="appId" class="base-app__appid muted">{{ appId }}</span>
      <span class="spacer" />
      <span v-if="model" class="muted">{{ model }}</span>
      <button v-if="pushAvailable()" type="button" class="base-app__notify" @click="enableNotifications">Enable phone notifications</button>
      <span v-if="status" class="base-app__status" data-status>{{ status }}</span>
      <span v-for="c in props.costs ?? []" :key="c.id" class="base-app__cost" :data-cost="c.id" :title="c.basis + (c.note ? ' · ' + c.note : '')">
        {{ c.label }} {{ costText(c) }}
        <button type="button" class="base-app__cost-toggle" :aria-pressed="c.freeTier" @click="emit('toggleFreeTier', c.id, !c.freeTier)">free tier {{ c.freeTier ? "on" : "off" }}</button>
      </span>
    </header>

    <div class="base-app__body">
      <aside v-if="$slots.nav" class="base-app__nav"><slot name="nav" /></aside>
      <main class="base-app__left" data-pane="left"><slot name="left" /></main>
      <section class="base-app__right" data-pane="right"><slot name="right" /></section>
    </div>

    <footer v-if="$slots.footer" class="base-app__footer"><slot name="footer" /></footer>
  </div>
</template>

<style scoped>
.base-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-family: system-ui, sans-serif;
  color: var(--base-app-fg, #e5e7eb);
  background: var(--base-app-bg, #111827);
}
.base-app__topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--base-app-border, #1f2937);
}
.base-app__title {
  font-size: 15px;
}
.base-app__status {
  color: var(--base-app-accent, #34d399);
}
.base-app__body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.base-app__nav {
  border-right: 1px solid var(--base-app-border, #1f2937);
  overflow: auto;
}
.base-app__left {
  overflow: auto;
  min-width: 0;
}
.base-app__right {
  border-left: 1px solid var(--base-app-border, #1f2937);
  overflow: auto;
  min-width: 0;
}
@media (max-width: 800px) {
  .base-app__body {
    grid-template-columns: minmax(0, 1fr);
  }
  .base-app__nav,
  .base-app__right {
    display: none;
  }
}
.base-app__footer {
  padding: 8px 14px;
  border-top: 1px solid var(--base-app-border, #1f2937);
}
.spacer {
  flex: 1;
}
.muted {
  opacity: 0.6;
}
</style>
