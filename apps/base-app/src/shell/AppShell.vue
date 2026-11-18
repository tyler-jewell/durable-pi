<script setup lang="ts">
// The canonical layout: top bar · nav rail · left (generated view + approval) · right (the DO
// streaming itself) · footer. Identity comes from props; content comes from named slots.
defineProps<{
  title: string;
  appId?: string;
  status?: string;
  model?: string;
}>();
</script>

<template>
  <div class="base-app" data-base-app>
    <header class="base-app__topbar">
      <strong class="base-app__title">{{ title }}</strong>
      <span v-if="appId" class="base-app__appid muted">{{ appId }}</span>
      <span class="spacer" />
      <span v-if="model" class="muted">{{ model }}</span>
      <span v-if="status" class="base-app__status" data-status>{{ status }}</span>
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
