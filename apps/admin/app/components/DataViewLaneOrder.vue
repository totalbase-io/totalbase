<script setup lang="ts">
// Kanban/Gantt "Lane order": each lane is one row of the table the
// `groupColumn` FK points at (types/dataview.ts, `KanbanLayoutConfig`).
// Move up/down, no drag - on the live board drag moves cards, not lanes.
// A row missing from the stored order is shown at the end, the way the
// live board places it, and only written once a lane is moved - so
// opening the settings page never reads as an edit.
import type { DisplayConfig } from '~/utils/display-field'
import { orderLanes } from '~/utils/dataview-columns'
import type { DataViewField } from '~/types/dataview'
import type { RelationDefinition } from '~/types/schema'

const laneOrder = defineModel<string[]>({ required: true })
const props = defineProps<{
  groupColumn: string | null
  relations?: RelationDefinition[]
  fields: DataViewField[]
  description: string
  emptyText: string
  /** The layout's lane order column - the lanes as the board shows them before any is moved. */
  orderColumn?: string | null
}>()
const { t } = useI18n()

// The relations too, not just the column: the source catalog and the stored groupColumn resolve independently, in
// no fixed order.
const rows = useLaneRows({
  relation: () => props.groupColumn ? props.relations?.find(r => r.sourceColumn === props.groupColumn) : undefined,
  display: () => props.fields.find(f => f.columnName === props.groupColumn)?.config as DisplayConfig | undefined,
  orderColumn: () => props.orderColumn
})
const orderedRows = computed(() => orderLanes(rows.value, laneOrder.value))

function move(index: number, direction: -1 | 1) {
  const order = orderedRows.value.map(r => r.pk)
  const next = index + direction
  if (next < 0 || next >= order.length) return
  ;[order[index], order[next]] = [order[next]!, order[index]!]
  laneOrder.value = order
}
</script>

<template>
  <UFormField
    :label="t('designer.dataViewLaneOrder.laneOrder')"
    :description="description"
  >
    <div
      v-if="orderedRows.length > 0"
      class="overflow-hidden rounded-lg border border-default"
    >
      <div
        v-for="(lane, index) in orderedRows"
        :key="lane.pk"
        class="flex items-center gap-2 border-b border-default px-3 py-2 last:border-b-0"
      >
        <div class="flex flex-col leading-none">
          <UButton
            icon="i-lucide-chevron-up"
            color="neutral"
            variant="ghost"
            size="xs"
            class="h-4 w-4 p-0"
            :disabled="index === 0"
            :aria-label="t('designer.dataViewLaneOrder.moveUp')"
            @click="move(index, -1)"
          />
          <UButton
            icon="i-lucide-chevron-down"
            color="neutral"
            variant="ghost"
            size="xs"
            class="h-4 w-4 p-0"
            :disabled="index === orderedRows.length - 1"
            :aria-label="t('designer.dataViewLaneOrder.moveDown')"
            @click="move(index, 1)"
          />
        </div>
        <p class="flex-1 truncate text-sm text-highlighted">
          {{ lane.label }}
        </p>
      </div>
    </div>
    <p
      v-else
      class="text-xs text-muted"
    >
      {{ emptyText }}
    </p>
  </UFormField>
</template>
