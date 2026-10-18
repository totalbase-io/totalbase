<script setup lang="ts">
/** The "which columns" checkbox list of the grid's Export and Print panels. */
export interface ColumnChecklistItem {
  key: string
  label: string
  selected: boolean
}

withDefaults(defineProps<{
  /** Tailwind max-height class for the scrolling list. */
  maxHeight?: string
}>(), { maxHeight: 'max-h-72' })
const items = defineModel<ColumnChecklistItem[]>({ required: true })
</script>

<template>
  <div
    class="flex flex-col gap-0.5 overflow-y-auto rounded-lg border border-default p-1"
    :class="maxHeight"
  >
    <label
      v-for="item in items"
      :key="item.key"
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elevated"
    >
      <UCheckbox
        v-model="item.selected"
        :aria-label="item.label"
      />
      <span class="flex-1 truncate text-sm">{{ item.label }}</span>
    </label>
  </div>
</template>
