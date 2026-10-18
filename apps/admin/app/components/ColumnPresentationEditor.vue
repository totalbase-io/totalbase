<script setup lang="ts">
/**
 * A column's presentation panel (Specification_DataViews.md §15), opened from wherever the column shows - a
 * DataView's Columns, a form field's inspector - over what the author was doing: the same panel as Database › a
 * table › Columns, loaded by itself from the resource and the column's name. After a save, the published DataViews it
 * reached, to publish or leave.
 */
import { checkConstraintValues, columnValueKind, type ColumnPresentation } from '@totalbase/tb-catalog'
import type { RelationDetail } from '~/types/schema'

const props = defineProps<{
  resourceId: string
  columnName: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const { resources } = useResourcesList()
const resource = computed(() => resources.value.find(r => r.id === props.resourceId) ?? null)

interface ColumnMeta { columnName: string, presentation: ColumnPresentation, inherited?: ColumnPresentation, automatic?: { input: string, widget: string, reason: string }, inputs?: string[] }
const detail = ref<RelationDetail | null>(null)
const meta = ref<ColumnMeta | null>(null)
watch([open, resource], async ([isOpen, found]) => {
  if (!isOpen || !found) return
  const [catalog, columns] = await Promise.all([
    api.get<RelationDetail>(`/catalog/${found.type === 'VIEW' ? 'view' : 'table'}/${found.id}`),
    api.get<ColumnMeta[]>(`/resources/${found.id}/columns`)
  ])
  detail.value = catalog.data
  meta.value = columns.data.find(c => c.columnName === props.columnName) ?? { columnName: props.columnName, presentation: {} }
}, { immediate: true })

const column = computed(() => detail.value?.columns.find(c => c.name === props.columnName) ?? null)
const kind = computed(() => {
  if (!column.value) return 'text' as const
  const relation = detail.value?.relations.find(r => r.sourceColumn === props.columnName)
  return columnValueKind(column.value.dataType, relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable } : null)
})
const checkValues = computed(() => checkConstraintValues(props.columnName, (detail.value?.checkConstraints ?? []).map(c => c.expression)))

const affected = ref<{ id: string, name: string, slug: string, liveVersion: number, otherChanges: boolean }[]>([])
const affectedOpen = ref(false)
async function saved() {
  emit('saved')
  try {
    affected.value = (await api.get<typeof affected.value>(`/resources/${props.resourceId}/affected-dataviews`)).data
    affectedOpen.value = affected.value.length > 0
  } catch {
    // Best-effort - the change is saved; each DataView still shows its Unpublished changes.
  }
}
</script>

<template>
  <ColumnPresentationSlideover
    v-if="resource && column && meta"
    v-model:open="open"
    :resource-id="resourceId"
    :column-name="columnName"
    :data-type="column.dataType"
    :kind="kind"
    :check-values="checkValues"
    :presentation="meta.presentation"
    :inherited="meta.inherited"
    :automatic="meta.automatic"
    :inputs="meta.inputs"
    :resource="resource"
    :columns="detail?.columns"
    @saved="saved"
  />
  <AffectedDataViewsModal
    v-model:open="affectedOpen"
    :dataviews="affected"
  />
</template>
