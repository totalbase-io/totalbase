<script setup lang="ts">
defineProps<{
  to?: string
  label?: string
}>()

const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <component
    :is="to ? NuxtLink : 'div'"
    :to="to"
    :aria-label="label"
    class="action-header"
  >
    <slot />
  </component>
</template>
