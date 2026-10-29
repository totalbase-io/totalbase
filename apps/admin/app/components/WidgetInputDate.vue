<script setup lang="ts">
/**
 * `UInputDate` adapter for a date or timestamp COLUMN field - Nuxt UI's
 * own `modelValue` is a reka-ui DateValue (from `@internationalized/date`),
 * never a plain string, but the column over the Data API is ISO text.
 * This is the one seam, so `WidgetRenderer.vue` binds `v-model` to the raw
 * column value like every other widget:
 *
 * - a `date` ("2024-01-15") is a `CalendarDate`, to the day;
 * - a `timestamp` is a `CalendarDateTime`, to the minute unless its
 *   Precision says otherwise; a `timestamptz` shows and is entered in the
 *   viewer's time zone (Settings / My account) and is written back as that
 *   instant - the same conversion as a datetime-local UInput
 *   (utils/datetime-local.ts).
 *
 * Typed segment by segment, or picked: a calendar button (`calendar`, on by default) opens Nuxt UI's
 * documented pattern - a UCalendar in a popover on the same value, in the UI's language and week, plus the
 * time for a timestamp. Its days stop at the column's CHECK bounds (`minDate`/`maxDate`: a day, `today`,
 * `after:`/`before:` one). Disabled, no button.
 */
import type { CalendarDate, CalendarDateTime, DateValue } from '@internationalized/date'
import { getLocalTimeZone, parseDate, parseDateTime, Time, today, toCalendarDate, toCalendarDateTime } from '@internationalized/date'
import { fromDateTimeLocal, pickerHourCycle, toDateTimeLocal } from '~/utils/datetime-local'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  disabled?: boolean
  /** The bound column's PostgreSQL type - a timestamp keeps its time. None: a date. */
  columnType?: string
  granularity?: 'day' | 'hour' | 'minute' | 'second'
  /** The calendar button - on unless turned off. */
  calendar?: boolean
  /** The first and last day it offers: `YYYY-MM-DD` or `today`, prefixed `after:`/`before:` for a strict bound. */
  minDate?: string
  maxDate?: string
}>(), { calendar: true })

const { t } = useI18n()
const { timezone } = useDateTimeFormat()
/** Today is the viewer's (Settings / My account), else the browser's. */
const zone = computed(() => timezone.value ?? getLocalTimeZone())
const isTimestamp = computed(() => /^timestamp/.test(props.columnType ?? ''))
const isZoned = computed(() => /with time zone/.test(props.columnType ?? ''))

const dateValue = computed<CalendarDate | CalendarDateTime | undefined>({
  get() {
    if (!modelValue.value) return undefined
    try {
      if (!isTimestamp.value) return parseDate(modelValue.value.slice(0, 10))
      const local = toDateTimeLocal(modelValue.value, isZoned.value, timezone.value)
      return local ? parseDateTime(local) : undefined
    } catch {
      return undefined
    }
  },
  set(value) {
    if (!value) {
      modelValue.value = null
      return
    }
    modelValue.value = isTimestamp.value
      ? fromDateTimeLocal(value.toString(), isZoned.value, timezone.value)
      : value.toString().slice(0, 10)
  }
})
/** A timestamp to the minute unless set; a date always to the day. */
const precision = computed(() => (isTimestamp.value ? props.granularity ?? 'minute' : 'day'))

/** The UI's language - the order and separators the viewer reads dates in; not Nuxt UI's (en). */
const ui = useUiLocale()
// The picker's month and day names: the UI's language.
const locale = computed(() => ui.languageTag.value)
// 12 or 24 hours: the regional format's (Admin_UI.md §14).
const hourCycle = computed(() => pickerHourCycle(ui.intlLocale.value))
/** The language's first day of the week (Monday in Spanish, Sunday in American English). */
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

function boundDay(bound: string | undefined): CalendarDate | undefined {
  if (!bound) return undefined
  const [, edge, day] = /^(after:|before:)?(.+)$/.exec(bound) ?? []
  try {
    const value = day === 'today' ? today(zone.value) : parseDate(day!)
    return edge === 'after:' ? value.add({ days: 1 }) : edge === 'before:' ? value.subtract({ days: 1 }) : value
  } catch {
    return undefined
  }
}
const minDay = computed(() => boundDay(props.minDate))
const maxDay = computed(() => boundDay(props.maxDate))

// The calendar picks the day; a timestamp keeps its time (midnight for a new one), set below it.
const calendarOpen = ref(false)
const pickedDay = computed<DateValue | undefined>({
  get: () => (dateValue.value ? toCalendarDate(dateValue.value) : undefined),
  set(day) {
    if (!day) return
    const date = toCalendarDate(day)
    if (!isTimestamp.value) {
      dateValue.value = date
      calendarOpen.value = false
      return
    }
    const current = dateValue.value as CalendarDateTime | undefined
    dateValue.value = toCalendarDateTime(date, current ? new Time(current.hour, current.minute, current.second) : new Time(0, 0))
  }
})
const pickedTime = computed<Time | undefined>({
  get: () => {
    const current = dateValue.value as CalendarDateTime | undefined
    return current && 'hour' in current ? new Time(current.hour, current.minute, current.second) : undefined
  },
  set(time) {
    if (!time) return
    const current = dateValue.value as CalendarDateTime | undefined
    const day = current ? toCalendarDate(current) : today(zone.value)
    dateValue.value = toCalendarDateTime(day, time)
  }
})
</script>

<template>
  <!-- Keyed: reka's DateField builds its segments once - a timestamp's catalog may arrive after it mounts. -->
  <UInputDate
    :key="precision"
    v-model="dateValue"
    :disabled="disabled"
    :locale="locale"
    :hour-cycle="hourCycle"
    :granularity="precision"
    :min-value="isTimestamp ? undefined : minDay"
    :max-value="isTimestamp ? undefined : maxDay"
  >
    <template
      v-if="calendar && !disabled"
      #trailing
    >
      <UPopover
        v-model:open="calendarOpen"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-calendar"
          color="neutral"
          variant="link"
          size="sm"
          :aria-label="t('dataviews.widgetInputDate.openCalendar')"
          class="px-0"
        />
        <template #content>
          <div class="flex flex-col gap-2 p-2">
            <UCalendar
              v-model="pickedDay"
              :locale="locale"
              :week-starts-on="weekStartsOn"
              :min-value="minDay"
              :max-value="maxDay"
            />
            <UInputTime
              v-if="isTimestamp"
              v-model="pickedTime"
              :locale="locale"
              :hour-cycle="hourCycle"
              :granularity="precision === 'day' ? 'minute' : precision"
              :aria-label="t('dataviews.widgetInputDate.time')"
              class="w-full"
            />
          </div>
        </template>
      </UPopover>
    </template>
  </UInputDate>
</template>
