<script setup lang="ts">
import UserCard from "./UserCard.vue";
const ada = { name: "Ada Lovelace", avatarUrl: "/ada.png" };
</script>

<template>
  <UserCard :user="ada" />
</template>
