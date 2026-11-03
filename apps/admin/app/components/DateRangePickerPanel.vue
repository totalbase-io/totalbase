<script setup lang="ts">
/**
 * What a DATE_RANGE picker opens (Dashboards.md §3.7): the quick ranges (the
 * presets) on one side, the custom range on the other - a `UInputDate range`
 * typed segment by segment, to the day or to the minute by the variable's
 * precision, and a `UCalendar range` on the same value - with Cancel / Apply
 * and, at the foot, the zone the times are read in. A preset applies at once;
 * a custom range on Apply, because each change re-runs widgets.
 *
 * The model is `@internationalized/date`'s, as WidgetInputDate's; the one seam
 * (`toWire`) serializes to the wire grammar - `YYYY-MM-DD`, or
 * `YYYY-MM-DDTHH:MM` at minute precision - with no zone conversion: PostgreSQL
 * reads the wall-clock time in the viewer's zone (§3.5).
 */
import type { CalendarDate, DateValue } from '@internationalized/date'
import { getLocalTimeZone, now, parseDate, parseDateTime, Time, toCalendarDate, toCalendarDateTime, today } from '@internationalized/date'
import type { DashboardRunTimezone, DashboardVariable, DateRangeValue } from '~/types/dashboard'
import { DATE_RANGE_PRESETS, useDashboardCatalogText } from '~/types/dashboard'
import { isCustomRange } from '~/utils/dashboard-variables'
import { pickerHourCycle } from '~/utils/datetime-local'
import { BROWSER_TIMEZONE } from '~/utils/api-headers'

const props = defineProps<{
  variable: DashboardVariable
  /** The range in effect - a preset, a custom range, or null (unset: no bounds). */
  modelValue: DateRangeValue | null
  /** The zone the last run used (`meta.timezone`) - the foot says it; unset, the viewer's effective zone. */
  runTimezone?: DashboardRunTimezone | null
}>()
const emit = defineEmits<{ pick: [value: DateRangeValue], cancel: [] }>()
const { t } = useI18n()
const catalog = useDashboardCatalogText()
const ui = useUiLocale()
const { timezone } = useDateTimeFormat()
const isMobile = useIsMobile()

const precision = computed(() => props.variable.precision ?? 'day')
/** Today, where the viewer is (Settings / My account, else the browser). */
const zone = computed(() => timezone.value ?? getLocalTimeZone())
const locale = computed(() => ui.languageTag.value)
const hourCycle = computed(() => pickerHourCycle(ui.intlLocale.value))
/** The language's first day of the week (Monday in Spanish, Sunday in American English) - as WidgetInputDate. */
const weekStartsOn = computed(() => {
  try {
    const info = new Intl.Locale(locale.value) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }, weekInfo?: { firstDay: number } }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    if (firstDay) return (firstDay % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
  } catch {
    // An engine without week info: below.
  }
  return String(locale.value).startsWith('en') ? 0 : 1
})

const presets = computed(() => DATE_RANGE_PRESETS.map(p => ({ value: p.value, label: catalog.presetLabel(p) })))
const activePreset = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : props.modelValue === null ? 'all' : null))

// --- The custom range being edited: a pair of DateValues (shallowRef: ref() would deep-unwrap the classes) ---
type Draft = { start: DateValue | undefined, end: DateValue | undefined }
const draft = shallowRef<Draft>(initialDraft())

function parseBound(text: string): DateValue {
  return precision.value === 'minute' ? parseDateTime(text) : parseDate(text)
}
/** The current custom range, or a sensible start: the last 30 days, or today from midnight to the next full hour. */
function initialDraft(): Draft {
  if (isCustomRange(props.modelValue)) {
    try {
      return { start: parseBound(props.modelValue.from), end: parseBound(props.modelValue.to) }
    } catch {
      // A value the picker can't read (hand-typed in the URL): start afresh below.
    }
  }
  if (precision.value === 'minute') {
    const current = now(zone.value)
    const start = toCalendarDateTime(toCalendarDate(current), new Time(0, 0))
    return { start, end: toCalendarDateTime(toCalendarDate(current), new Time(current.hour, 0)).add({ hours: 1 }) }
  }
  const end = today(zone.value)
  return { start: end.subtract({ days: 30 }), end }
}

/** The days alone, for the calendar: at minute precision a picked day keeps the typed time. */
const days = computed<{ start: CalendarDate | undefined, end: CalendarDate | undefined }>({
  get: () => ({ start: draft.value.start ? toCalendarDate(draft.value.start) : undefined, end: draft.value.end ? toCalendarDate(draft.value.end) : undefined }),
  set(range) {
    if (precision.value !== 'minute') {
      draft.value = { start: range?.start, end: range?.end }
      return
    }
    const time = (previous: DateValue | undefined, fallback: Time) => (previous && 'hour' in previous ? new Time(previous.hour, previous.minute) : fallback)
    draft.value = {
      start: range?.start ? toCalendarDateTime(range.start, time(draft.value.start, new Time(0, 0))) : undefined,
      end: range?.end ? toCalendarDateTime(range.end, time(draft.value.end, new Time(0, 0))) : undefined
    }
  }
})

/** A bound as the server reads it (Dashboards.md §3.4). */
function toWire(value: DateValue): string {
  return precision.value === 'minute' ? toCalendarDateTime(value).toString().slice(0, 16) : toCalendarDate(value).toString()
}
const valid = computed(() => {
  const { start, end } = draft.value
  if (!start || !end) return false
  const order = start.compare(end)
  return precision.value === 'minute' ? order < 0 : order <= 0
})
function apply() {
  if (!valid.value) return
  emit('pick', { from: toWire(draft.value.start!), to: toWire(draft.value.end!) })
}

/** The zone the times are read in: the run's (what PostgreSQL used), else the viewer's effective one. */
const zoneLine = computed(() => {
  const run = props.runTimezone
  if (run?.source === 'POSTGRESQL') return t('dashboards.rangePicker.timesInDatabase')
  return t('dashboards.rangePicker.timesIn', { zone: run?.name ?? timezone.value ?? BROWSER_TIMEZONE })
})
</script>

<template>
  <div
    class="flex gap-4"
    :class="isMobile ? 'flex-col' : 'flex-row'"
  >
    <!-- Quick ranges: a preset applies at once. -->
    <div
      class="flex shrink-0 flex-col gap-0.5"
      :class="isMobile ? 'w-full' : 'w-40'"
      role="group"
      :aria-label="t('dashboards.rangePicker.quickRanges')"
    >
      <span class="px-2 pb-1 text-xs font-medium text-muted">{{ t('dashboards.rangePicker.quickRanges') }}</span>
      <UButton
        v-for="preset in presets"
        :key="preset.value"
        :label="preset.label"
        color="neutral"
        :variant="activePreset === preset.value ? 'soft' : 'ghost'"
        size="sm"
        class="justify-start"
        @click="emit('pick', preset.value)"
      />
    </div>

    <!-- The custom range: typed, or picked on the calendar - applied on Apply. -->
    <div class="flex min-w-0 flex-col gap-3">
      <span class="text-xs font-medium text-muted">{{ t('dashboards.variablesBar.customRange') }}</span>
      <!-- Keyed: reka's DateField builds its segments once, per granularity. -->
      <UInputDate
        :key="precision"
        v-model="draft"
        range
        :locale="locale"
        :hour-cycle="hourCycle"
        :granularity="precision"
        size="sm"
        class="w-full"
        :aria-label="t('dashboards.variablesBar.customRange')"
      />
      <UCalendar
        v-model="days"
        range
        :locale="locale"
        :week-starts-on="weekStartsOn"
      />
      <div
        class="flex items-center justify-between gap-3"
        :class="isMobile ? 'flex-col items-stretch' : undefined"
      >
        <span class="text-xs text-muted">{{ zoneLine }}</span>
        <div class="flex justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="emit('cancel')"
          />
          <UButton
            :label="t('common.apply')"
            size="sm"
            :disabled="!valid"
            @click="apply"
          />
        </div>
      </div>
    </div>
  </div>
</template>
