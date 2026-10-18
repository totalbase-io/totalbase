<script setup lang="ts">
/**
 * Kanban/Gantt lanes: which columns of the related table (the lanes' own
 * rows - the table `groupColumn` points at) order them and color them
 * (`laneOrderColumn`, `laneColorColumn`, types/dataview.ts). Set at
 * creation from that table's `position` and `color` when it has them;
 * changed here. Its columns come from the related table's own catalog.
 */
import { isNumericDataType } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition, RelationDetail } from '~/types/schema'

const orderColumn = defineModel<string | null>('orderColumn', { required: true })
const colorColumn = defineModel<string | null>('colorColumn', { required: true })
const props = defineProps<{
  groupColumn: string | null
  relations?: RelationDefinition[]
}>()
const { t } = useI18n()

const api = useAdminApi()
const { resources } = useResourcesList()
const targetColumns = ref<CatalogColumn[]>([])
watch([() => props.groupColumn, () => props.relations, resources], async ([columnName, relations]) => {
  targetColumns.value = []
  const relation = relations?.find(r => r.sourceColumn === columnName)
  if (!relation) return
  const target = resources.value.find(r => r.schema === relation.targetSchema && r.name === relation.targetTable)
  if (!target) return
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/${target.type === 'VIEW' ? 'view' : 'table'}/${target.postgresOid}`)
    targetColumns.value = data.columns
  } catch {
    // Best-effort - the pickers just stay empty, same as an unmapped Group by.
  }
}, { immediate: true })
// Only once the related catalog has loaded - an empty list is "not yet": a column it no longer has is cleared.
watch(targetColumns, (cols) => {
  if (!cols.length) return
  if (orderColumn.value && !cols.some(c => c.name === orderColumn.value)) orderColumn.value = null
  if (colorColumn.value && !cols.some(c => c.name === colorColumn.value)) colorColumn.value = null
})

const orderItems = computed(() => targetColumns.value.filter(c => isNumericDataType(c.dataType)).map(c => c.name))
const colorItems = computed(() => targetColumns.value.filter(c => /^(text|character varying|character|citext)/.test(c.dataType)).map(c => c.name))
const orderModel = computed({
  get: () => orderColumn.value ?? undefined,
  set: (value: string | undefined) => { orderColumn.value = value ?? null }
})
const colorModel = computed({
  get: () => colorColumn.value ?? undefined,
  set: (value: string | undefined) => { colorColumn.value = value ?? null }
})
</script>

<template>
  <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
    <UFormField
      :label="t('designer.dataViewLaneColumns.laneOrderColumn')"
      :description="t('designer.dataViewLaneColumns.laneOrderColumnHelp')"
    >
      <USelectMenu
        v-model="orderModel"
        :items="orderItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('designer.dataViewLaneColumns.laneColorColumn')"
      :description="t('designer.dataViewLaneColumns.laneColorColumnHelp')"
    >
      <USelectMenu
        v-model="colorModel"
        :items="colorItems"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
