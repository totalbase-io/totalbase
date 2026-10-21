<script setup lang="ts">
/**
 * One column's place in a default order (Foundations.md §11.7, DataViews.md §4): none, ascending or
 * descending, with its priority when several columns order - a click cycles none -> asc -> desc -> none, as clicking
 * a grid's header does. The same control in a resource's Columns (its default order) and a DataView's (its own).
 */
defineProps<{
  direction: 'asc' | 'desc' | null
  /** 1-based, shown when more than one column orders. */
  priority?: number
  /** The current state and what a click does - the button's tooltip and accessible name. */
  hint: string
}>()
const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <UTooltip :text="hint">
    <UButton
      :icon="direction === 'desc' ? 'i-lucide-arrow-down-z-a' : direction === 'asc' ? 'i-lucide-arrow-down-a-z' : 'i-lucide-square-dashed'"
      :color="direction ? 'primary' : 'neutral'"
      :variant="direction ? 'solid' : 'ghost'"
      size="xs"
      :label="priority !== undefined ? String(priority) : undefined"
      :aria-label="hint"
      @click="emit('click')"
    />
  </UTooltip>
</template>
