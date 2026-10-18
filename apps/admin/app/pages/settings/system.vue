<script setup lang="ts">
// A saved name or logo shows everywhere through useInstance - read it again.
const { refresh } = useInstance()
</script>

<template>
  <SettingsGroupForm
    group="system"
    @saved="refresh().catch(() => undefined)"
  />
</template>
