<script setup lang="ts">
// GANTT layout of a DataView grid: one bar per row between its start and
// end dates (`gantt_layout`, types/dataview.ts), in one flat lane or a
// lane per related row when a Group by FK is set (Kanban's mechanism).
// Dragging a bar, or one of its edges, emits `update-row`.
import { displayColumns, displayText, type DisplayConfig } from '~/utils/display-field'
import { addDays } from 'date-fns'
import { DEFAULT_GANTT_BAR_COLOR, itemColor, GANTT_UNASSIGNED_KEY, type DataViewField, type GanttLayoutConfig, type GanttZoom } from '~/types/dataview'
import type { RelationDefinition } from '~/types/schema'
import type { GanttBar, GanttLane } from './DataViewGantt.vue'
import { cappedNotice, columnField } from '~/utils/dataview-columns'
import { wallClockColumnValue } from '~/utils/datetime-local'

const zoom = defineModel<GanttZoom>('zoom', { required: true })
const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: GanttLayoutConfig
  relations?: RelationDefinition[]
  primaryKey?: string
  canWrite: boolean
  total: number
  limit: number
  /** The viewer's effective time zone (undefined = the browser's) - bars are placed and rescheduled in it. */
  timezone?: string
}>()
/** The lanes this viewer folded (their keys) - kept with the viewer's prefs, as a Kanban's. */
const collapsedLanes = defineModel<string[]>('collapsedLanes', { default: () => [] })
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'update-row': [change: { row: Record<string, unknown>, data: Record<string, unknown>, errorTitle: string }]
}>()

const dataApi = useDataApi()
const { t } = useI18n()
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.titleFormula, props.layout?.descriptionFormula, props.layout?.colorFormula])

const startField = computed(() => columnField(props.fields, props.layout?.startDateColumn))
const endField = computed(() => columnField(props.fields, props.layout?.endDateColumn))
const groupField = computed(() => columnField(props.fields, props.layout?.groupColumn))
const relation = computed(() => props.relations?.find(r => r.sourceColumn === props.layout?.groupColumn) ?? null)

const progressField = computed(() => columnField(props.fields, props.layout?.progressColumn))
/** The row's progress, 0-100 - null without a progress column or a value. */
function progressOf(row: Record<string, unknown>): number | null {
  const column = progressField.value?.columnName
  const value = column ? Number(formula.cellValue.value(row, column)) : Number.NaN
  return column && row[column] !== null && row[column] !== undefined && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
}

/** null when start/end don't both resolve or end is before start - skipped, never misdrawn. Its color: its formula's, else its lane's, else the default. */
function barFor(row: Record<string, unknown>, index: number, laneColor: string | null = null): GanttBar | null {
  const start = formula.dateValue(startField.value, row)
  const end = formula.dateValue(endField.value, row)
  if (!start || !end || end < start) return null
  const title = formula.evaluateRich(props.layout?.titleFormula, row)
  const description = props.layout?.descriptionFormula ? formula.evaluateRich(props.layout.descriptionFormula, row) : null
  return {
    key: props.primaryKey ? String(row[props.primaryKey]) : String(index),
    start,
    end,
    title: title.text,
    titleRich: title.rich,
    description: description?.text || null,
    descriptionRich: description?.rich,
    color: itemColor(formula.evaluate(props.layout?.colorFormula, row) || laneColor || undefined, props.layout?.defaultColor, DEFAULT_GANTT_BAR_COLOR),
    progress: progressOf(row),
    row
  }
}
const byStart = (a: GanttBar, b: GanttBar) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime()

/** Kanban's related-row fetch, plus the optional lane color column off the same rows. */
interface LaneRow { pk: string, label: string, color: string | null }
const laneRows = ref<LaneRow[]>([])
watch([relation, () => props.layout?.laneOrderColumn, () => props.layout?.laneColorColumn], async ([target, orderColumn, colorColumn]) => {
  laneRows.value = []
  // What its lanes are titled by - the group column's display, one related column or a template.
  const display = groupField.value?.widget === 'USelectMenu' ? groupField.value.config as DisplayConfig : undefined
  const shownColumns = displayColumns(display)
  if (!target || shownColumns.length === 0) return
  try {
    const { data } = await dataApi.get<Record<string, unknown>[]>(
      dataApi.resourcePath(target.targetSchema, target.targetTable),
      { fields: [...new Set([target.targetColumn, ...shownColumns, colorColumn].filter((c): c is string => !!c))].join(','), order_by: orderColumn || shownColumns[0], limit: 100 }
    )
    laneRows.value = data.map(row => ({
      pk: String(row[target.targetColumn]),
      label: displayText(display, c => row[c]) ?? String(row[target.targetColumn]),
      color: colorColumn && typeof row[colorColumn] === 'string' ? row[colorColumn] as string : null
    }))
  } catch {
    // Best-effort - the timeline renders with only the Unassigned lane.
  }
}, { immediate: true })

const resolved = computed<{ lanes: GanttLane[], skipped: number }>(() => {
  const groupColumn = props.layout?.groupColumn
  let skipped = 0
  if (!groupColumn) {
    const bars: GanttBar[] = []
    props.rows.forEach((row, index) => {
      const bar = barFor(row, index)
      if (bar) bars.push(bar)
      else skipped += 1
    })
    return { lanes: [{ key: '__all__', title: null, color: null, bars: bars.sort(byStart) }], skipped }
  }
  const orderIndex = new Map((props.layout?.laneOrder ?? []).map((pk, i) => [pk, i]))
  const ordered = [...laneRows.value].sort((a, b) => (orderIndex.get(a.pk) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.pk) ?? Number.MAX_SAFE_INTEGER))
  const lanes: GanttLane[] = ordered.map(r => ({ key: r.pk, title: r.label, color: r.color, bars: [] }))
  const laneByKey = new Map(lanes.map(l => [l.key, l]))
  const unassigned: GanttLane = { key: GANTT_UNASSIGNED_KEY, title: t('dataviews.layouts.unassigned'), color: null, bars: [] }
  props.rows.forEach((row, index) => {
    const raw = row[groupColumn]
    const lane = (raw === null || raw === undefined ? undefined : laneByKey.get(String(raw))) ?? unassigned
    const bar = barFor(row, index, lane.color)
    if (!bar) {
      skipped += 1
      return
    }
    lane.bars.push(bar)
  })
  for (const lane of [...lanes, unassigned]) lane.bars.sort(byStart)
  // Unassigned only when a task has no lane - nothing can be dropped on a timeline's lane.
  return { lanes: unassigned.bars.length > 0 ? [...lanes, unassigned] : lanes, skipped }
})
const capped = computed(() => cappedNotice(props.total, props.limit, t('dataviews.layouts.capWhere.timeline')))

/**
 * Shifts the dragged edge - or both, a whole bar moved - by whole days, at
 * the same time of day as the viewer sees it (utils/datetime-local.ts).
 */
function onReschedule({ row, edge, deltaDays }: { row: Record<string, unknown>, edge: 'start' | 'end' | 'both', deltaDays: number }) {
  const data: Record<string, unknown> = {}
  for (const field of edge === 'both' ? [startField.value, endField.value] : [edge === 'start' ? startField.value : endField.value]) {
    const original = formula.dateValue(field, row)
    if (!field?.columnName || !original) return
    data[field.columnName] = wallClockColumnValue(addDays(original, deltaDays), field.config as { displayFormatKind?: string, displayFormatTzAware?: boolean }, props.timezone)
  }
  emit('update-row', { row, data, errorTitle: edge === 'both' ? t('dataviews.layouts.moveBarError') : t('dataviews.layouts.resizeBarError') })
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
    v-if="resolved.skipped > 0"
    color="neutral"
    variant="subtle"
    icon="i-lucide-calendar-x"
    :title="t('dataviews.layouts.skipped.timeline', { count: resolved.skipped })"
  />
  <UAlert
    v-if="!layout?.startDateColumn || !layout?.endDateColumn"
    color="neutral"
    variant="subtle"
    icon="i-lucide-gantt-chart-square"
    :title="t('dataviews.layouts.noRangeColumns')"
  />
  <DataViewGantt
    v-model:zoom="zoom"
    v-model:collapsed="collapsedLanes"
    class="min-h-96 flex-1"
    :lanes="resolved.lanes"
    :grouped="!!layout?.groupColumn"
    :can-write="canWrite"
    :timezone="timezone"
    @edit="emit('edit', $event)"
    @reschedule="onReschedule"
  />
</template>
