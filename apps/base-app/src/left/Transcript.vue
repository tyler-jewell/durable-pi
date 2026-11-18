<script setup lang="ts">
import type { TranscriptItem as TranscriptItemType } from "@sdk/transcript";
import TranscriptItem from "./TranscriptItem.vue";

defineProps<{ items: TranscriptItemType[] }>();
const emit = defineEmits<{ fork: [entryId: number] }>();
</script>

<template>
  <div class="transcript" data-transcript>
    <TranscriptItem
      v-for="item in items"
      :key="`${item.kind}:${item.id}`"
      :item="item"
      @fork="emit('fork', $event)"
    />
  </div>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
