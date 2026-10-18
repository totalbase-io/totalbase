<script setup lang="ts">
/**
 * TBox - a plain area grouping a page's widgets (Specification_DataViews.md §14.2):
 * no frame, header or padding of its own - the Style tab gives
 * it its look. Nuxt UI has no such container; a Card brings its own frame.
 */
defineSlots<{ default?: () => unknown }>()
</script>

<template>
  <div>
    <slot />
  </div>
</template>
