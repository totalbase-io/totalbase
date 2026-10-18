<script setup lang="ts">
const route = useRoute()
await navigateTo({ path: '/sql-console', query: route.query }, { replace: true })
</script>

<template>
  <div />
</template>
