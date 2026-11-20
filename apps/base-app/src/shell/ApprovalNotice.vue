<script setup lang="ts">
defineProps<{ title: string; body: string }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <article class="notice" role="status" aria-label="Notification" data-notice>
    <p class="notice__app">Durable Pi</p>
    <h2 class="notice__title">{{ title }}</h2>
    <p class="notice__body">{{ body }}</p>
    <button type="button" class="notice__open" data-notice-open @click="emit('open')">Open and answer</button>
  </article>
</template>

<style scoped>
.notice {
  position: fixed;
  top: 12px;
  right: 12px;
  left: 12px;
  z-index: 20;
  width: auto;
  max-width: 360px;
  margin-left: auto;
  padding: 14px 16px;
  border: 1px solid #374151;
  border-left: 4px solid #34d399;
  border-radius: 16px;
  background: #1f2937;
  color: #f9fafb;
  box-shadow: 0 16px 40px rgb(0 0 0 / 35%);
}
.notice__app {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #9ca3af;
}
.notice__title {
  margin: 4px 0 0;
  font-size: 16px;
}
.notice__body {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 1.4;
}
.notice__open {
  margin-top: 12px;
  border: 0;
  border-radius: 999px;
  padding: 8px 14px;
  background: #34d399;
  color: #064e3b;
  font-weight: 650;
}
</style>
