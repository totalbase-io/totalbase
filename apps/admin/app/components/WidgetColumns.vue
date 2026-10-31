<script setup lang="ts">
/**
 * TColumns - side by side areas in one row (DataViews.md §12.2, §14.2):
 * each column an area of its own, its width in the row's 12 columns
 * (`span`, the widths summing to 12), what it holds stacking inside it.
 * The row is a `.widget-area` like any other - each column its span of
 * 12 (`spanStyle`) - so a phone stacks the columns the way it stacks a
 * page's widgets (main.css).
 */
import type { WidgetItem } from '@totalbase/tb-catalog'
import { spanStyle } from '~/utils/widget-layout'

const props = defineProps<{ items?: WidgetItem[] }>()
defineSlots<{ column?: (props: { item: WidgetItem, index: number }) => unknown }>()

const columns = computed(() => (props.items ?? []).filter((item): item is WidgetItem => item !== null && typeof item === 'object'))
</script>

<template>
  <!-- A `.widget-area` line (main.css): each column its span of 12, the gaps accounted for; a phone stacks them. -->
  <div class="widget-area w-full min-w-0">
    <div
      v-for="(item, index) in columns"
      :key="item.value ?? index"
      class="min-w-0"
      :style="spanStyle(item.span)"
    >
      <slot
        name="column"
        :item="item"
        :index="index"
      />
    </div>
  </div>
</template>
