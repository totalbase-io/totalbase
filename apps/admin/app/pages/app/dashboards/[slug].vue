<script setup lang="ts">
// A published Dashboard inside the App (Specification_Security.md §8).
const route = useRoute()
const slug = computed(() => String(route.params.slug))
</script>

<template>
  <DashboardViewer
    :key="slug"
    :slug="slug"
  />
</template>
