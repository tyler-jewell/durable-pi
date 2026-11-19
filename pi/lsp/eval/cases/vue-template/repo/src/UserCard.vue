<script setup lang="ts">
defineProps<{ user: { name: string; avatarUrl: string } }>();
</script>

<template>
  <figure class="card">
    <img :src="user.avatar" alt="" />
    <figcaption>{{ user.fullName }}</figcaption>
  </figure>
</template>
