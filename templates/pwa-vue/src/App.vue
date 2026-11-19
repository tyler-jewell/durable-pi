<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

// Offline-first: the app shell is precached, so the page keeps working without a network. The status line says which copy the user sees.
const online = ref(true);
const update = () => (online.value = navigator.onLine);
onMounted(() => {
  update();
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
});
onUnmounted(() => {
  window.removeEventListener("online", update);
  window.removeEventListener("offline", update);
});
</script>

<template>
  <div class="shell">
    <header class="top">
      <nav aria-label="Main">
        <RouterLink to="/">Home</RouterLink>
      </nav>
      <p id="connection" role="status">{{ online ? "Online" : "Offline: showing the saved copy" }}</p>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>
