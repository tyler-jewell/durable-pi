<script setup lang="ts">
// The collapsible nav rail: pick which object the left panel renders. Generic — each DO app
// declares its own object list (sessions, incidents, deploys, …).
import type { NavItem } from "./types";

defineProps<{ items: NavItem[]; selected?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <nav class="nav-rail" data-nav-rail aria-label="Objects">
    <button
      v-for="item in items"
      :key="item.id"
      class="nav-item"
      :class="{ selected: item.id === selected }"
      :aria-current="item.id === selected ? 'true' : undefined"
      @click="emit('select', item.id)"
    >
      <span class="nav-item-label">{{ item.label }}</span>
      <span v-if="item.kind" class="nav-item-kind muted">{{ item.kind }}</span>
    </button>
  </nav>
</template>

<style scoped>
.nav-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  min-width: 160px;
}
.nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 8px;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.nav-item:hover {
  background: #1f2937;
}
.nav-item.selected {
  background: #1f2937;
  box-shadow: inset 2px 0 0 var(--base-app-accent, #34d399);
}
.nav-item-label {
  font-weight: 600;
}
.nav-item-kind {
  font-size: 11px;
}
.muted {
  opacity: 0.6;
}
</style>
