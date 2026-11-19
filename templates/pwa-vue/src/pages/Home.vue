<script setup lang="ts">
import { ref } from "vue";
import AppDialog from "../components/AppDialog.vue";

const dialog = ref<InstanceType<typeof AppDialog> | null>(null);
</script>

<template>
  <section class="page">
    <h1>__APP_TITLE__</h1>
    <p>Works offline once loaded, and fits from a phone to a large TV.</p>
    <ul class="cards">
      <li>Responsive grid</li>
      <li>Offline-first shell</li>
      <li>Installable PWA</li>
    </ul>
    <button id="open-dialog" type="button" @click="dialog?.show()">Open dialog</button>
    <AppDialog ref="dialog" title="Confirm">
      <p>Native dialog: focus is trapped, Escape closes it, focus returns here.</p>
    </AppDialog>
  </section>
</template>
