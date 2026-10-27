<script setup lang="ts">
/**
 * A list in a card (Admin_UI.md §5.10): rows separated by rules on the subtle surface of UPageCard's
 * `subtle` variant - the dashboard template's Members list. A toolbar (add, search) is its first row; the
 * section's title and actions sit above it, in a SettingsSection.
 */
withDefaults(defineProps<{ tag?: 'div' | 'ul' }>(), { tag: 'div' })
</script>

<template>
  <component
    :is="tag"
    class="flex flex-col divide-y divide-default rounded-lg bg-elevated/50 ring ring-default"
  >
    <slot />
  </component>
</template>
