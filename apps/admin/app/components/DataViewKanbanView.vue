<script setup lang="ts">
import type { CardMark } from '~/utils/column-conditions'
// KANBAN layout of a DataView grid: a lane per row of the table the
// `groupColumn` FK points at - or per value of its CHECK list, in the CHECK's
// order, labelled, colored and iconed by its column's presentation -, plus a
// fixed Unassigned lane (`kanban_layout`, types/dataview.ts). A card is CARDS'
// own card. Dropping a card on another lane emits `update-row` - the grid
// PATCHes it through the Data API like any edit and refetches; PostgreSQL
// decides. `readOnly`: the cards stay where the data puts them.
import { displayColumns, displayText, type DisplayConfig } from '~/utils/display-field'
import { KANBAN_UNASSIGNED_KEY, type DataViewField, type KanbanLayoutConfig } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import type { KanbanCard, KanbanLane } from './DataViewKanban.vue'
import { cappedNotice, columnField } from '~/utils/dataview-columns'

const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: KanbanLayoutConfig
  relations?: RelationDefinition[]
  catalogColumns?: CatalogColumn[]
  /** The source's CHECK lists (`estado IN ('A', 'B')`), by column - a lane per value when Group by is one. */
  checkValues?: Record<string, string[]>
  primaryKey?: string
  canWrite: boolean
  total: number
  limit: number
  /** A row condition's mark on its card. */
  markOf?: (row: Record<string, unknown>) => CardMark | null
}>()
/** The lanes this viewer folded (their keys) - the grid keeps them with the viewer's prefs. */
const collapsedLanes = defineModel<string[]>('collapsedLanes', { default: () => [] })
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'update-row': [change: { row: Record<string, unknown>, data: Record<string, unknown>, errorTitle: string }]
}>()

const dataApi = useDataApi()
const { t } = useI18n()
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.titleFormula, props.layout?.descriptionFormula, props.layout?.imageFormula])

const groupField = computed(() => columnField(props.fields, props.layout?.groupColumn))
const relation = computed(() => props.relations?.find(r => r.sourceColumn === props.layout?.groupColumn) ?? null)
/** A NOT NULL group column can't be cleared by a drop, so Unassigned then takes none. Nullable until the catalog says otherwise - never lock a lane out while it loads. */
const groupNullable = computed(() => props.catalogColumns?.find(c => c.name === props.layout?.groupColumn)?.nullable ?? true)

/**
 * The related table's rows - the board's lanes. One page of 100 ordered
 * by the display field, the same fetch ForeignKeySelect.vue makes;
 * refetched only when the relation changes. `rawValue` (the target PK's
 * real type) is what a drop PATCHes; `pk` is its string form for lookups.
 */
interface LaneRow { pk: string, rawValue: unknown, label: string, color: string | null, icon?: string | null }
const fetchedLaneRows = ref<LaneRow[]>([])
/** Theme colors a CHECK value's presentation names, as the lanes' palette. */
const THEME_TO_PALETTE: Record<string, string> = { primary: 'sky', secondary: 'violet', success: 'green', info: 'blue', warning: 'amber', error: 'red' }
/** Group by a CHECK list: its values, in its order. */
const checkLaneRows = computed<LaneRow[] | null>(() => {
  const column = props.layout?.groupColumn
  const values = !relation.value && column ? props.checkValues?.[column] : undefined
  if (!values) return null
  const options = groupField.value?.inherited?.options ?? {}
  return values.map(value => ({ pk: value, rawValue: value, label: options[value]?.label ?? value, color: options[value]?.color ? THEME_TO_PALETTE[options[value]!.color!] ?? null : null, icon: options[value]?.icon ?? null }))
})
const laneRows = computed(() => checkLaneRows.value ?? fetchedLaneRows.value)
// Ordered by the layout's lane order column (the related table's `position`), else by name; tinted by its color column.
watch([relation, () => props.layout?.laneOrderColumn, () => props.layout?.laneColorColumn], async ([target, orderColumn, colorColumn]) => {
  fetchedLaneRows.value = []
  // What its lanes are titled by - the group column's display, one related column or a template.
  const display = groupField.value?.widget === 'USelectMenu' ? groupField.value.config as DisplayConfig : undefined
  const shownColumns = displayColumns(display)
  if (!target || shownColumns.length === 0) return
  try {
    const { data } = await dataApi.get<Record<string, unknown>[]>(
      dataApi.resourcePath(target.targetSchema, target.targetTable),
      { fields: [...new Set([target.targetColumn, ...shownColumns, colorColumn].filter((c): c is string => !!c))].join(','), order_by: orderColumn || shownColumns[0], limit: 100 }
    )
    fetchedLaneRows.value = data.map(row => ({
      pk: String(row[target.targetColumn]),
      rawValue: row[target.targetColumn],
      label: displayText(display, c => row[c]) ?? String(row[target.targetColumn]),
      color: colorColumn && typeof row[colorColumn] === 'string' ? row[colorColumn] as string : null
    }))
  } catch {
    // Best-effort - the board renders with only the Unassigned lane.
  }
}, { immediate: true })

function cardFor(row: Record<string, unknown>, index: number): KanbanCard {
  const title = formula.evaluateRich(props.layout?.titleFormula, row)
  const description = props.layout?.descriptionFormula ? formula.evaluateRich(props.layout.descriptionFormula, row) : null
  return {
    key: props.primaryKey ? String(row[props.primaryKey]) : String(index),
    title: title.text,
    titleRich: title.rich,
    description: description?.text || null,
    descriptionRich: description?.rich,
    imageSrc: props.layout?.imageFormula ? (formula.imageSrc(props.layout.imageFormula, row) ?? '') : null,
    row
  }
}
/** `laneOrder` first; a related row missing from it goes at the end, in fetch order. */
const lanes = computed<KanbanLane[]>(() => {
  const groupColumn = props.layout?.groupColumn
  if (!groupColumn) return []
  const orderIndex = new Map((props.layout?.laneOrder ?? []).map((pk, i) => [pk, i]))
  const ordered = [...laneRows.value].sort((a, b) => (orderIndex.get(a.pk) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.pk) ?? Number.MAX_SAFE_INTEGER))
  const result: KanbanLane[] = ordered.map(r => ({ key: r.pk, title: r.label, color: r.color, icon: r.icon, droppable: !props.layout?.readOnly, cards: [] }))
  const laneByKey = new Map(result.map(l => [l.key, l]))
  const unassigned: KanbanLane = { key: KANBAN_UNASSIGNED_KEY, title: t('dataviews.layouts.unassigned'), color: null, droppable: groupNullable.value && !props.layout?.readOnly, cards: [] }
  props.rows.forEach((row, index) => {
    const raw = row[groupColumn]
    const lane = raw === null || raw === undefined ? undefined : laneByKey.get(String(raw))
    ;(lane ?? unassigned).cards.push(cardFor(row, index))
  })
  // A NOT NULL column with no row lacking it: no lane that could never hold a card.
  return groupNullable.value || unassigned.cards.length > 0 ? [...result, unassigned] : result
})
const capped = computed(() => cappedNotice(props.total, props.limit, t('dataviews.layouts.capWhere.board')))

function onMove({ row, targetLaneKey }: { row: Record<string, unknown>, targetLaneKey: string }) {
  const groupColumn = props.layout?.groupColumn
  if (!groupColumn) return
  const value = targetLaneKey === KANBAN_UNASSIGNED_KEY ? null : (laneRows.value.find(r => r.pk === targetLaneKey)?.rawValue ?? null)
  emit('update-row', { row, data: { [groupColumn]: value }, errorTitle: t('dataviews.layouts.moveCardError') })
}
</script>

<template>
  <UAlert
    v-if="capped"
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    :title="capped"
  />
  <UAlert
    v-if="!layout?.groupColumn"
    color="neutral"
    variant="subtle"
    icon="i-lucide-columns-3"
    :title="t('dataviews.layouts.noGroupColumn')"
  />
  <DataViewKanban
    v-model:collapsed="collapsedLanes"
    class="min-h-96 flex-1"
    :lanes="lanes"
    :can-write="canWrite && !layout?.readOnly"
    :mark-of="markOf"
    @edit="emit('edit', $event)"
    @move="onMove"
  />
</template>
