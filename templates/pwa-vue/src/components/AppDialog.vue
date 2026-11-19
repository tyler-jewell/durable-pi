<script setup lang="ts">
import { ref } from "vue";

// A native modal <dialog>: the browser makes the page behind it inert, moves focus in, closes on Escape and returns
// focus to the element that opened it (Modern Web Guidance: dialog).
const dialog = ref<HTMLDialogElement | null>(null);
defineProps<{ title: string }>();
defineExpose({ show: () => dialog.value?.showModal(), close: () => dialog.value?.close() });
</script>

<template>
  <dialog ref="dialog" class="app-dialog" :aria-label="title">
    <h2>{{ title }}</h2>
    <slot />
    <form method="dialog">
      <button autofocus value="close">Close</button>
    </form>
  </dialog>
</template>
