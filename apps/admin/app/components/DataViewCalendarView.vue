<script setup lang="ts">
// CALENDAR layout of a DataView grid: rows placed by one date column
// (`calendar_layout`, types/dataview.ts). The visible range (view +
// reference date) is a v-model - the grid fetches by it. Dropping an
// event on another day emits `update-row`; clicking an empty day or hour
// emits `create` with the date column pre-filled.
import { setHours, setMinutes, setSeconds } from 'date-fns'
import { DEFAULT_CALENDAR_EVENT_COLOR, itemColor, type CalendarLayoutConfig, type CalendarViewMode, type DataViewField } from '~/types/dataview'
import type { CalendarEvent } from './DataViewCalendar.vue'
import { cappedNotice, columnField } from '~/utils/dataview-columns'
import { wallClockColumnValue } from '~/utils/datetime-local'

const view = defineModel<CalendarViewMode>('view', { required: true })
const referenceDate = defineModel<Date>('referenceDate', { required: true })
const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: CalendarLayoutConfig
  primaryKey?: string
  canWrite: boolean
  timeFormat: string
  /** The viewer's effective time zone (undefined = the browser's) - a timestamptz is placed, moved and created in it. */
  timezone?: string
  pending: boolean
  total: number
  limit: number
}>()
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'create': [initialValues: Record<string, unknown>]
  'update-row': [change: { row: Record<string, unknown>, data: Record<string, unknown>, errorTitle: string }]
}>()

const { t } = useI18n()
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.titleFormula, props.layout?.descriptionFormula, props.layout?.colorFormula])
const dateField = computed(() => columnField(props.fields, props.layout?.dateColumn))
const dateConfig = computed(() => (dateField.value?.config ?? {}) as { displayFormatKind?: string, displayFormatTzAware?: boolean })
/** A timestamp column: its events have a time of day. */
const timed = computed(() => dateConfig.value.displayFormatKind === 'datetime')

/** The column's value for a wall-clock time on the calendar - utils/datetime-local.ts. */
function columnValue(wallClock: Date): string {
  return wallClockColumnValue(wallClock, dateConfig.value, props.timezone)
}

/** A row whose date doesn't resolve is left out and counted - never misplaced. */
const resolved = computed<{ events: CalendarEvent[], skipped: number }>(() => {
  if (!dateField.value?.columnName) return { events: [], skipped: 0 }
  let skipped = 0
  const events: CalendarEvent[] = []
  props.rows.forEach((row, index) => {
    const date = formula.dateValue(dateField.value, row)
    if (!date) {
      skipped += 1
      return
    }
    const title = formula.evaluateRich(props.layout?.titleFormula, row)
    const description = props.layout?.descriptionFormula ? formula.evaluateRich(props.layout.descriptionFormula, row) : null
    events.push({
      key: props.primaryKey ? String(row[props.primaryKey]) : String(index),
      date,
      title: title.text,
      titleRich: title.rich,
      description: description?.text || null,
      descriptionRich: description?.rich,
      color: itemColor(formula.evaluate(props.layout?.colorFormula, row), props.layout?.defaultColor, DEFAULT_CALENDAR_EVENT_COLOR),
      timed: timed.value,
      row
    })
  })
  events.sort((a, b) => a.date.getTime() - b.date.getTime())
  return { events, skipped }
})
const capped = computed(() => cappedNotice(props.total, props.limit, t('dataviews.layouts.capWhere.calendar')))

/** Moves the event to the target day at the same time of day, as the viewer sees it. */
function onMove({ row, targetDate }: { row: Record<string, unknown>, targetDate: Date }) {
  const column = props.layout?.dateColumn
  const original = formula.dateValue(dateField.value, row)
  if (!column || !original) return
  const moved = setSeconds(setMinutes(setHours(targetDate, original.getHours()), original.getMinutes()), original.getSeconds())
  emit('update-row', { row, data: { [column]: columnValue(moved) }, errorTitle: t('dataviews.layouts.rescheduleError') })
}

/** A click on a day (its midnight) or an hour (Day view): New with the column set to it. */
function onCreateOnDay(day: Date) {
  const column = props.layout?.dateColumn
  if (!column) return
  emit('create', { [column]: columnValue(day) })
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
    :title="t('dataviews.layouts.skipped.calendar', { count: resolved.skipped })"
  />
  <UAlert
    v-if="!layout?.dateColumn"
    color="neutral"
    variant="subtle"
    icon="i-lucide-calendar-days"
    :title="t('dataviews.layouts.noDateColumn')"
  />
  <DataViewCalendar
    v-model:view="view"
    v-model:reference-date="referenceDate"
    class="min-h-96 flex-1"
    :events="resolved.events"
    :can-write="canWrite"
    :week-starts-on="layout?.weekStartsOn ?? 0"
    :time-format="timeFormat"
    :timezone="timezone"
    :pending="pending"
    @edit="emit('edit', $event)"
    @move="onMove"
    @create-on-day="onCreateOnDay"
  />
</template>
