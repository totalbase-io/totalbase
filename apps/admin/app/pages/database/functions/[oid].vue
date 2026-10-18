<script setup lang="ts">
// Old `/database/<kind>/<oid>` links: resources are addressed by their
// TotalBase id (stable across renames), so resolve the OID to it.
const route = useRoute()
const resource = await useResourcesApi().getByOid(route.params.oid as string).catch(() => null)
await navigateTo(
  resource ? { path: `/resources/${resource.id}`, query: route.query } : '/resources',
  { replace: true }
)
</script>

<template>
  <div />
</template>
