<script setup lang="ts">
/**
 * The `CALENDAR` layout's own render (DataViewGrid.vue's own `isCalendar`
 * branch) - same "dumb, receives events already resolved" split
 * DataViewCard.vue/DataViewMap.vue/DataViewKanban.vue already follow:
 * every value shown here (event title/description/color) is resolved by
 * the parent via the exact same `computedValueResolver`/
 * `useLayoutFormula` CARDS/MAP/KANBAN already use. This component IS
 * in charge of its own Prev/Next/Today/view-switcher navigation, though
 * (unlike a Kanban board or a map, which have nothing month/week/day-
 * shaped to navigate) - `view`/`referenceDate` are `defineModel`s (same
 * two-way pattern `open` uses on DataViewRecordPanel.vue/EditFormShell.vue)
 * so the PARENT still owns the actual state (it has to - the visible
 * range drives what DataViewGrid.vue fetches), while this component is
 * free to mutate it directly on a Prev/Next/Today click or a view-switch,
 * without round-tripping every gesture through a bespoke event per
 * action.
 *
 * No calendar library (`@fullcalendar/core` or similar) - same call the
 * project already made for KANBAN's drag&drop (native Drag and Drop API,
 * no library) and MAP's tiles (Leaflet IS a real dependency there, but
 * only because there's no sane way to hand-roll map tile rendering; a
 * month/week grid is just `<div>`s). `date-fns` (already a real
 * dependency - WidgetFormattedDate.vue/format-pattern.ts) supplies the
 * month/week grid math instead of hand-rolled date arithmetic.
 *
 * Week/Day/Agenda are deliberately simpler than Month - a flat list of
 * that day's (or week's/every visible day's) events, not an hour-of-day
 * timeline grid. An hour grid is a real feature (event stacking/overlap
 * layout, an all-day row, a "now" indicator) - out of scope for v1 same
 * as GANTT's own timeline bars are; Month is the one view that actually
 * needs its own 2D grid (a day has no "hour" dimension to lay events out
 * along), so it's the one that gets the real layout work here.
 */
import { CalendarDate } from '@internationalized/date'
import { addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, setHours, startOfDay, startOfMonth, startOfWeek } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import { clockOptions } from '~/utils/datetime-local'
import type { CalendarViewMode } from '~/types/dataview'
import { isValidColorValue, roleColorShade } from '~/types/permission'
import type { FormulaRichSegment } from '~/utils/formula-engine'

/** One resolved event - `row`/`date` are passed back whole on edit/move, same as every other layout's own resolved-item shape. `title`/`description` are always the plain, flattened text (formatting stripped) - the same fallback every other Card/Map/Kanban layout slot already gets; `titleRich`/`descriptionRich` are only set when that formula actually used a FORMAT function, rendered through `renderRichTextHtml` same as Kanban's own `richHtml`. No icon field at all: an event chip has no room for one the way a map pin does. */
export interface CalendarEvent {
  key: string
  date: Date
  title: string
  titleRich?: FormulaRichSegment[]
  description: string | null
  descriptionRich?: FormulaRichSegment[]
  /** A plain `string`, not `RoleColor` - `colorFormula` can evaluate to anything (a builder's own mistake, or the raw row data itself); `chipBackground`/`ColorDot` below are what actually validate it, same "the render layer is the one place that decides valid-or-not" split `roleColorShade`'s own doc comment describes. */
  color: string
  /** Its date has a time of day (a timestamp column) - shown before its title. */
  timed: boolean
  row: Record<string, unknown>
}

const props = defineProps<{
  events: CalendarEvent[]
  canWrite: boolean
  /** `CalendarLayoutConfig.weekStartsOn` (types/dataview.ts's own doc comment) - which day Month's own grid/Week's own columns/`rangeLabel`'s own week-boundary start on. Defaults to `0` (Sunday) only via that resolver, never a bare fallback here - every real caller already resolves the layout first, same as every other prop this component takes. */
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6
  /** DataViewGrid.vue's own `pending` (its `useAsyncData` fetch state) - surfaced here as a small spinner next to Prev/Next/Today: paging months/weeks re-fetches a brand new range each time (this DataView's own doc comment on why CALENDAR never loads "everything" up front), and without SOME feedback that refetch can read as the click having done nothing for a moment. */
  pending?: boolean
  /** The viewer's effective time zone (undefined = the browser's): today and "now" are theirs, as the events' dates are. */
  timezone?: string
}>()
const emit = defineEmits<{
  'edit': [Record<string, unknown>]
  /** Click on a day's (Month/Week) or an hour's (Day) free space - New with that date. An event's own click opens it instead; never when `!canWrite`. */
  'create-on-day': [Date]
  /** An event dropped on a DIFFERENT day than the one it started on (Month and Week - Day/Agenda are lists of one day's or many days' events, nothing to drop onto). Preserving the event's own time-of-day (if the date column is a timestamp) is the PARENT's job, same division as Kanban's own drop (DataViewCalendarView.vue does it) - this only ever reports "this event moved to this NEW DAY". */
  'move': [{ row: Record<string, unknown>, targetDate: Date }]
}>()

const view = defineModel<CalendarViewMode>('view', { required: true })
/** A phone: the view switcher is a select, the range label its own row. */
const isMobile = useIsMobile()
const referenceDate = defineModel<Date>('referenceDate', { required: true })
const { t } = useI18n()
const ui = useUiLocale()
/** A date in the UI's language - month and day names (date-fns). */
function fmt(date: Date, pattern: string): string {
  return format(date, pattern, { locale: ui.dateFns.value })
}
/** A date pattern that also changes its order per language ("September 7" / "7 de septiembre"). */
const pattern = (name: string) => t(`dataviews.calendar.patterns.${name}`)

const VIEW_OPTIONS = computed<{ value: CalendarViewMode, label: string }[]>(() => [
  { value: 'agenda', label: t('dataviews.calendar.views.agenda') },
  { value: 'day', label: t('dataviews.calendar.views.day') },
  { value: 'week', label: t('dataviews.calendar.views.week') },
  { value: 'month', label: t('dataviews.calendar.views.month') }
])

// Agenda lists a month, as Month shows one - Previous/Next step a month (T60).
function goPrev() {
  referenceDate.value = view.value === 'month' || view.value === 'agenda' ? addMonths(referenceDate.value, -1) : view.value === 'week' ? addWeeks(referenceDate.value, -1) : addDays(referenceDate.value, -1)
}
function goNext() {
  referenceDate.value = view.value === 'month' || view.value === 'agenda' ? addMonths(referenceDate.value, 1) : view.value === 'week' ? addWeeks(referenceDate.value, 1) : addDays(referenceDate.value, 1)
}
function goToday() {
  referenceDate.value = nowInZone()
}
/** Now as a wall-clock time in the viewer's zone - comparable with the events' dates. */
function nowInZone(): Date {
  return props.timezone ? toZonedTime(new Date(), props.timezone) : new Date()
}
function isToday(day: Date): boolean {
  return isSameDay(day, now.value)
}
/** An event's time of day ("14:30"), in the viewer's clock - empty for a date column. */
function eventTime(event: CalendarEvent): string {
  return event.timed ? event.date.toLocaleTimeString(ui.intlLocale.value, { hour: '2-digit', minute: '2-digit', ...clockOptions() }) : ''
}
/**
 * The toolbar's own title - a week's own date range for Week, "September
 * 2026" for Month. Day/Agenda instead render THIS SAME text as a
 * separate, centered, CLICKABLE label below the toolbar (the template's
 * own doc comment on `jumpPickerOpen` - opens a real date-picker to jump
 * straight to any date: neither view shows
 * a grid a builder could otherwise page through/scan to find a distant
 * date, unlike Month/Week).
 */
const rangeLabel = computed(() => {
  if (view.value === 'day') return fmt(referenceDate.value, pattern('day'))
  if (view.value === 'week') {
    const start = startOfWeek(referenceDate.value, { weekStartsOn: props.weekStartsOn })
    const end = addDays(start, 6)
    return isSameMonth(start, end) ? `${fmt(start, pattern('weekStart'))} – ${fmt(end, pattern('weekEnd'))}` : `${fmt(start, pattern('weekCrossStart'))} – ${fmt(end, pattern('weekCrossEnd'))}`
  }
  // Agenda lists the reference date's month, past days included - titled like Month (T60).
  return fmt(referenceDate.value, pattern('month'))
})

// --- "Jump to date" (Day/Agenda only - this file's own `rangeLabel`
// doc comment) - a real date-picker (Nuxt UI's own `UCalendar`, reka-ui
// underneath) so a builder can land on a distant date in one pick
// instead of paging prev/next one day at a time. `UCalendar`'s own
// `modelValue` is a `CalendarDate` (`@internationalized/date`), not a
// plain JS `Date` - same one conversion seam `WidgetInputDate.vue`'s own
// doc comment already documents for the exact same reason.
const jumpPickerOpen = ref(false)
const jumpPickerValue = computed<CalendarDate>({
  get() {
    const d = referenceDate.value
    return new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
  },
  set(value) {
    referenceDate.value = new Date(value.year, value.month - 1, value.day)
    jumpPickerOpen.value = false
  }
})

/** Sun..Sat, ROTATED to start on `weekStartsOn` - Month's own header row and the day-of-week each grid column falls under both need to agree with the exact same rotation `monthDays`/`weekDays` below already build their own date ranges with. */
const WEEKDAY_LABELS = computed(() => {
  // Sunday 4 January 2026 onwards - the short names in the UI's language.
  const labels = Array.from({ length: 7 }, (_, day) => fmt(new Date(2026, 0, 4 + day), 'EEE'))
  return [...labels.slice(props.weekStartsOn), ...labels.slice(0, props.weekStartsOn)]
})

// --- Month grid - 6 full weeks (always, even when the month itself only
// spans 4-5 - a fixed-height grid never jumps size as the user pages
// between months) starting/ending on `weekStartsOn` (this DataView's own
// CalendarLayoutConfig setting - types/dataview.ts's own doc comment),
// same `startOfWeek`/`endOfWeek` padding date pickers use everywhere
// else in this app (WidgetInputDate.vue's own reka-ui Calendar), just
// parametrized instead of always Sunday.
const monthDays = computed(() => {
  const start = startOfWeek(startOfMonth(referenceDate.value), { weekStartsOn: props.weekStartsOn })
  const end = endOfWeek(endOfMonth(referenceDate.value), { weekStartsOn: props.weekStartsOn })
  return eachDayOfInterval({ start, end })
})
const weekDays = computed(() => {
  const start = startOfWeek(referenceDate.value, { weekStartsOn: props.weekStartsOn })
  return eachDayOfInterval({ start, end: addDays(start, 6) })
})
function eventsOn(day: Date): CalendarEvent[] {
  return props.events.filter(e => isSameDay(e.date, day))
}
/** Day view's own hour rows (its own doc comment on the template below) - a plain `0..23` list, always the full day (no "business hours" trimming - every hour is shown). */
const DAY_HOURS = Array.from({ length: 24 }, (_, hour) => hour)
function eventsAtHour(day: Date, hour: number): CalendarEvent[] {
  return props.events.filter(e => isSameDay(e.date, day) && e.date.getHours() === hour)
}
function hourLabel(hour: number): string {
  // The regional format's clock: "14:00" or "2:00 PM".
  return setHours(startOfDay(referenceDate.value), hour).toLocaleTimeString(ui.intlLocale.value, { hour: 'numeric', minute: '2-digit', ...clockOptions() })
}
/** Agenda's own flat list - every event `events` currently holds (already bounded to the fetched range - DataViewGrid.vue's own doc comment on why CALENDAR fetches by visible range, not a flat cap), grouped by day, in date order. */
const agendaGroups = computed(() => {
  const byDay = new Map<string, { date: Date, events: CalendarEvent[] }>()
  for (const event of [...props.events].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const key = format(event.date, 'yyyy-MM-dd')
    if (!byDay.has(key)) byDay.set(key, { date: event.date, events: [] })
    byDay.get(key)!.events.push(event)
  }
  return [...byDay.values()]
})

const MAX_CHIPS_PER_DAY = 3

/** A click on a day's free space - its events and "+N more" stop their own clicks. */
function onDayClick(day: Date) {
  if (!props.canWrite) return
  emit('create-on-day', day)
}
/** Click on an hour row's free space in Day view - `onDayClick`'s gesture, pinned to that hour. */
function onHourClick(hour: number) {
  if (!props.canWrite) return
  emit('create-on-day', setHours(startOfDay(referenceDate.value), hour))
}

// --- Keyboard shortcuts - arrow keys/T/D/W/M/A, `useCalendarShortcuts.ts`'s
// own doc comment on why plain keys are safe here (typing-target guard).
// `ref(true)` (always active) - unlike the record form's own equivalent
// composable, this component doesn't stay mounted-but-hidden the way
// DataViewRecordPanel.vue's Drawer/Modal/Sidebar does; it's only ever in
// the DOM while CALENDAR is actually the visible layout.
useCalendarShortcuts(ref(true), {
  onPrev: goPrev,
  onNext: goNext,
  onToday: goToday,
  onViewChange: (v) => { view.value = v }
})

// --- "Now" line (Day view only) - a live horizontal marker at the
// current time, same "glanceable, not just implied by scrolling to the
// right spot" reasoning every mainstream calendar app already applies.
// Re-evaluated every minute (not more often - a redraw every second for
// something this coarse would just burn cycles for no visible gain).
const now = ref(nowInZone())
let nowTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = nowInZone()
  }, 60_000)
})
onBeforeUnmount(() => {
  if (nowTimer !== undefined) clearInterval(nowTimer)
})
const currentHour = computed(() => now.value.getHours())
/** Where inside the CURRENT hour's own row to draw the line, as a percentage of that row's own height - not an absolute pixel offset computed from an assumed fixed row height, which would drift the moment a row with more events than fits its `min-h-14` actually grows taller. A percentage anchored to the row it's drawn INSIDE stays correct regardless of that row's real rendered height. */
const currentMinutePercent = computed(() => (now.value.getMinutes() / 60) * 100)

/** Day view's own hour-row elements, keyed by hour - just enough to `scrollIntoView` the current one below, not a full component-wide refs system. */
const dayHourEls: Record<number, HTMLElement | null> = {}
function setDayHourEl(hour: number, el: unknown) {
  dayHourEls[hour] = el instanceof HTMLElement ? el : null
}
/** Auto-scrolls Day view to the current hour the moment it becomes the active view for TODAY - never for a past/future date (there's no "current hour" to scroll to there, so it stays wherever the browser's own default scroll position lands, same as before this existed). Re-runs on `referenceDate` too, so jumping to today (Today button, or the date-picker) while already on Day view still scrolls, not just the initial switch into it. */
watch([view, referenceDate], async ([activeView, date]) => {
  if (activeView !== 'day' || !isToday(date)) return
  await nextTick()
  dayHourEls[currentHour.value]?.scrollIntoView({ block: 'center' })
}, { immediate: true })

// --- "Add to calendar" (.ics) - Day/Agenda rows only (this file's own
// doc comment on where: the two spots roomy enough to show one event at
// a time in real detail, unlike Month/Week's own cramped one-line
// chips). A plain, dependency-free RFC 5545 VEVENT - no recurrence, no
// timezone block (a "floating" local time, interpreted in whatever
// calendar app opens it in ITS OWN local zone - the same wall-clock
// hour/minute this component already displays, `date`'s own
// `toZonedTime`-adjusted getters if the source column was a real
// `timestamptz`, useLayoutFormula.ts's `dateValue` doc comment).
// A flat 1-hour duration - CALENDAR has no end-time column at all (the
// chat's own decision: a single date column, never a start/end pair,
// that's GANTT's job), so there's no real duration to read from
// anywhere.
function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}
function icsDate(date: Date): string {
  return format(date, 'yyyyMMdd\'T\'HHmmss')
}
function downloadIcs(event: CalendarEvent) {
  const end = new Date(event.date.getTime() + 60 * 60 * 1000)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TotalBase//Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${event.key}@totalbase`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(event.date)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${icsEscape(event.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Same "sanitize a builder-authored string before it becomes a
  // filename" discipline DataViewGrid.vue's own CSV/Excel export
  // already applies to `resourceName` - a title formula can contain
  // slashes/colons/etc, none of which belong in a filename.
  a.download = `${(event.title || 'event').replace(/[/\\?%*:|"<>]/g, '-')}.ics`
  a.click()
  URL.revokeObjectURL(url)
}

// --- Drag&drop (Month and Week) - native Drag and Drop API, same
// mechanics/doc comment as DataViewKanban.vue's own `draggingCard`.
const draggingEvent = ref<CalendarEvent | null>(null)
const dragOverDay = ref<string | null>(null)
function dayKey(day: Date): string {
  return format(day, 'yyyy-MM-dd')
}
function onDragStart(event: CalendarEvent) {
  if (!props.canWrite) return
  draggingEvent.value = event
}
function onDragEnd() {
  draggingEvent.value = null
  dragOverDay.value = null
}
function onDrop(day: Date) {
  dragOverDay.value = null
  const dragging = draggingEvent.value
  draggingEvent.value = null
  if (!dragging || isSameDay(dragging.date, day)) return
  emit('move', { row: dragging.row, targetDate: day })
}

// --- "+N more" overflow popover (Month view only) - which day cell's
// popover is currently open, `null` when none is. Only one at a time,
// same single-value-not-a-set convention DataViewKanban.vue's own
// `dragOverLaneKey` already uses for "at most one of these active".
const overflowDayKey = ref<string | null>(null)

const colorMode = useColorMode()

/** A soft, always-legible chip background - same `roleColorShade` static oklch table DataViewMap.vue's own pin/ColorDot.vue already use (NOT a `--ui-color-*` CSS variable - ColorDot.vue's own doc comment on why that only covers Nuxt UI's 7 semantic colors, not the full RoleColor palette an event's color is picked from), mixed down to ~18% opacity over the page's own background so light text/icons underneath stay readable in both themes. Given an invalid (non-palette) color, `roleColorShade` itself returns `'transparent'` - the `color-mix` below then also comes out fully transparent, leaving `chipInvalidClass` (right below) as the ONLY visible signal on the chip itself that something's wrong, same "the dot alone isn't enough" reasoning ColorDot.vue's own doc comment gives for its dashed ring. */
function chipBackground(color: string): string {
  const hex = roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light')
  return `color-mix(in oklab, ${hex} 18%, transparent)`
}
/** A dashed, error-tinted outline for a chip/row whose own `color` didn't resolve to a real palette name - stacks with whatever other conditional classes a given render spot already has (Month's own drag/hover classes, etc.), never REPLACES them. */
function chipInvalidClass(color: string): string {
  return isValidColorValue(color) ? '' : 'ring-1 ring-dashed ring-error ring-inset'
}

// Each event's rich title/description as safe HTML, keyed by `event.key`.
const richHtml = useRichHtml(() => props.events)
</script>

<template>
  <div class="flex size-full min-h-96 flex-col gap-3">
    <!-- Prev/Next/Today + range label + view switcher - this component's
    own toolbar row (this file's own doc comment on why navigation lives
    here, not in the parent). A 3-column grid, not a plain
    `justify-between` flex row - Day/Agenda's own "jump to date" trigger
    (center column) needs to sit at the SAME row height as Prev/Next/
    Today and the view switcher either side of it, not on a row of its
    own below; a grid's own center column stays visually
    centered regardless of the left/right columns' own widths, which a
    plain flex `justify-between` can't do once there's a THIRD thing to
    place. On a phone: two columns (navigation | view select), the
    center column wrapping to a row of its own below them. -->
    <div class="grid grid-cols-2 items-center gap-2 md:grid-cols-3">
      <div class="flex flex-wrap items-center gap-1.5">
        <UButton
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('dataviews.record.previous')"
          @click="goPrev"
        />
        <UButton
          icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('common.next')"
          @click="goNext"
        />
        <UButton
          :label="t('dataviews.calendar.today')"
          color="neutral"
          variant="outline"
          size="sm"
          @click="goToday"
        />
        <!-- Refetching a new range (Prev/Next/Today/the date-picker,
        `pending`'s own doc comment) - a small spinner, not a full-panel
        overlay: the CURRENTLY shown events stay visible/interactive
        until the new range actually arrives, same "don't blank the
        screen for a refetch" restraint the rest of this app's own
        loading states already follow. -->
        <UIcon
          v-if="pending"
          name="i-lucide-loader-circle"
          class="size-4 animate-spin text-muted"
        />
        <!-- Month/Week only - Day/Agenda instead render this SAME text
        as the centered "jump to date" trigger in the middle column
        (this file's own `rangeLabel`/`jumpPickerOpen` doc comments) -
        showing it in BOTH places would just repeat the same date twice. -->
        <p
          v-if="(view === 'month' || view === 'week') && !isMobile"
          class="ml-2 text-sm font-semibold text-highlighted"
        >
          {{ rangeLabel }}
        </p>
      </div>

      <!-- "Jump to date" - Day/Agenda only (`rangeLabel`'s own doc
      comment on why: neither shows a grid to page/scan through, unlike
      Month/Week). -->
      <div class="col-span-2 row-start-2 flex justify-center md:col-span-1 md:row-start-auto">
        <p
          v-if="(view === 'month' || view === 'week') && isMobile"
          class="text-sm font-semibold text-highlighted"
        >
          {{ rangeLabel }}
        </p>
        <UPopover
          v-if="view === 'day' || view === 'agenda'"
          v-model:open="jumpPickerOpen"
        >
          <UButton
            :label="rangeLabel"
            icon="i-lucide-calendar"
            color="neutral"
            variant="ghost"
            size="sm"
          />
          <template #content>
            <UCalendar v-model="jumpPickerValue" />
          </template>
        </UPopover>
      </div>

      <!-- Plain flex row of buttons, not a fused segmented control - this
      Nuxt UI install (v4.11) has no `UButtonGroup` at all (unlike the
      v3.x one this file's own first draft assumed, going by an older
      sibling project - the console warning that caught it:
      "Failed to resolve component: UButtonGroup"), so this stays
      individually-rounded UButtons instead of hand-rolling that fused
      look's own first/last-child border-radius overrides for one small
      view switcher. -->
      <div class="flex flex-wrap justify-end gap-1.5">
        <USelect
          v-if="isMobile"
          v-model="view"
          :items="VIEW_OPTIONS"
          size="sm"
          class="w-28"
          :aria-label="t('dataviews.calendar.viewAria')"
        />
        <UButton
          v-for="opt in (isMobile ? [] : VIEW_OPTIONS)"
          :key="opt.value"
          :label="opt.label"
          size="sm"
          :color="view === opt.value ? 'primary' : 'neutral'"
          :variant="view === opt.value ? 'solid' : 'outline'"
          @click="view = opt.value"
        />
      </div>
    </div>

    <!-- MONTH - a real 7-col grid, drag&drop between days, "+N more"
    overflow. Weekday labels are their OWN grid, a separate element from
    the day cells below (not one shared 7-row grid) - a single grid whose
    rows are all `auto`-sized stretches every "auto" row to fill any
    LEFTOVER container height (CSS Grid's own default `align-content:
    stretch`, distributed across implicit tracks) once this component's
    own `flex-1`/`min-h-96` makes the container taller than its natural
    content - the header row grew exactly as tall as a day row from that,
    not from any height class on the header itself. Splitting it out
    means only the day-cell grid (given `auto-rows-fr` below, so its own
    6 week-rows still split any leftover height evenly among THEMSELVES)
    is subject to that stretch, and the header stays its own one-line
    height regardless of how much room this component ends up with.
    Real per-cell `border-b`/`border-r` (not a `gap-px`+background-color
    trick, which silently disappears the moment a cell's own background
    matches the container's - exactly what made the grid lines invisible
    before this) - the container itself only needs its own top/left edge
    (`border-t`/`border-l`), every cell's bottom/right edge closes off
    the rest, including the outer right/bottom edge, with no doubled-up
    border anywhere. -->
    <div
      v-if="view === 'month'"
      class="flex flex-1 flex-col overflow-hidden rounded-lg border-t border-l border-default"
    >
      <div class="grid shrink-0 grid-cols-7">
        <div
          v-for="label in WEEKDAY_LABELS"
          :key="label"
          class="border-r border-b border-default bg-elevated px-2 py-1.5 text-center text-xs font-medium text-muted"
        >
          {{ label }}
        </div>
      </div>

      <div class="grid flex-1 auto-rows-fr grid-cols-7">
        <div
          v-for="day in monthDays"
          :key="dayKey(day)"
          class="flex min-h-24 flex-col gap-1 border-r border-b border-default bg-default p-1.5 transition-colors"
          :class="[
            !isSameMonth(day, referenceDate) ? 'opacity-40' : '',
            dragOverDay === dayKey(day) ? 'ring-2 ring-inset ring-primary/50' : '',
            canWrite ? 'cursor-pointer hover:bg-elevated/50' : ''
          ]"
          @dragover.prevent="dragOverDay = dayKey(day)"
          @dragleave="dragOverDay === dayKey(day) && (dragOverDay = null)"
          @drop.prevent="onDrop(day)"
          @click="onDayClick(day)"
        >
          <span
            class="self-end rounded-full px-1.5 text-xs"
            :class="isToday(day) ? 'bg-primary text-inverted font-semibold' : 'text-muted'"
          >
            {{ format(day, 'd') }}
          </span>

          <div class="flex flex-col gap-0.5">
            <div
              v-for="event in eventsOn(day).slice(0, MAX_CHIPS_PER_DAY)"
              :key="event.key"
              :draggable="canWrite"
              class="flex items-center gap-1 truncate rounded px-1 py-0.5 text-xs hover:opacity-80"
              :class="[{ 'opacity-40': draggingEvent?.key === event.key }, chipInvalidClass(event.color)]"
              role="button"
              tabindex="0"
              :style="{ backgroundColor: chipBackground(event.color) }"
              @click.stop="emit('edit', event.row)"
              @keydown.enter.space.prevent="emit('edit', event.row)"
              @dragstart="onDragStart(event)"
              @dragend="onDragEnd"
            >
              <ColorDot
                :color="event.color"
                size="xs"
              />
              <span
                v-if="event.timed"
                class="shrink-0 tabular-nums text-muted"
              >{{ eventTime(event) }}</span>
              <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
              <span
                v-if="richHtml[event.key]?.title"
                class="truncate"
                v-html="richHtml[event.key]!.title"
              />
              <!-- eslint-enable vue/no-v-html -->
              <span
                v-else
                class="truncate"
              >{{ event.title }}</span>
            </div>

            <UPopover
              v-if="eventsOn(day).length > MAX_CHIPS_PER_DAY"
              :open="overflowDayKey === dayKey(day)"
              @update:open="(v) => (overflowDayKey = v ? dayKey(day) : null)"
            >
              <UButton
                :label="t('dataviews.calendar.more', { count: eventsOn(day).length - MAX_CHIPS_PER_DAY })"
                color="neutral"
                variant="link"
                size="xs"
                @click.stop
              />
              <template #content>
                <div class="flex max-h-64 w-56 flex-col gap-1 overflow-y-auto p-2">
                  <p class="px-1 pb-1 text-xs font-medium text-muted">
                    {{ fmt(day, pattern('dayHeading')) }}
                  </p>
                  <button
                    v-for="event in eventsOn(day)"
                    :key="event.key"
                    type="button"
                    class="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-elevated"
                    @click="overflowDayKey = null; emit('edit', event.row)"
                  >
                    <ColorDot
                      :color="event.color"
                      size="xs"
                    />
                    <span
                      v-if="event.timed"
                      class="shrink-0 tabular-nums text-muted"
                    >{{ eventTime(event) }}</span>
                    <span class="truncate">{{ event.title }}</span>
                  </button>
                </div>
              </template>
            </UPopover>
          </div>
        </div>
      </div>
    </div>

    <!-- WEEK - 7 columns, each a plain stacked list (this file's own doc
    comment on why Week/Day/Agenda skip an hour-timeline for v1). -->
    <div
      v-else-if="view === 'week'"
      class="grid flex-1 grid-cols-7 gap-2"
    >
      <div
        v-for="day in weekDays"
        :key="dayKey(day)"
        class="flex min-h-64 flex-col gap-1.5 rounded-lg border border-default p-2"
        :class="[canWrite ? 'cursor-pointer hover:bg-elevated/50' : '', dragOverDay === dayKey(day) ? 'ring-2 ring-inset ring-primary/50' : '']"
        @dragover.prevent="dragOverDay = dayKey(day)"
        @dragleave="dragOverDay === dayKey(day) && (dragOverDay = null)"
        @drop.prevent="onDrop(day)"
        @click="onDayClick(day)"
      >
        <p
          class="text-xs font-medium"
          :class="isToday(day) ? 'text-primary' : 'text-muted'"
        >
          {{ fmt(day, 'EEE d') }}
        </p>
        <button
          v-for="event in eventsOn(day)"
          :key="event.key"
          type="button"
          :draggable="canWrite"
          class="flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-xs hover:opacity-80"
          :class="[{ 'opacity-40': draggingEvent?.key === event.key }, chipInvalidClass(event.color)]"
          :style="{ backgroundColor: chipBackground(event.color) }"
          @click.stop="emit('edit', event.row)"
          @dragstart="onDragStart(event)"
          @dragend="onDragEnd"
        >
          <ColorDot
            :color="event.color"
            size="xs"
          />
          <span
            v-if="event.timed"
            class="shrink-0 tabular-nums text-muted"
          >{{ eventTime(event) }}</span>
          <span class="truncate">{{ event.title }}</span>
        </button>
      </div>
    </div>

    <!-- DAY - an hour-of-day grid (00:00-23:00), one row per hour - unlike
    Month/Week (a day has no "hour" dimension worth laying out, this
    file's own top doc comment), the Day view IS specifically about ONE
    day, so an hour timeline earns its place here: clicking an EMPTY hour
    row opens New pre-filled to that exact hour (`onHourClick` below),
    same "click an empty slot to create" gesture Month/Week already give
    a whole day. An event with a time-of-day that isn't exactly on the
    hour (11:30, say) still renders inside that HOUR's row - no sub-hour
    positioning, this is a list of rows, not a real timeline layout. -->
    <div
      v-else-if="view === 'day'"
      class="flex-1 overflow-y-auto rounded-lg border border-default"
    >
      <div
        v-for="hour in DAY_HOURS"
        :key="hour"
        :ref="(el) => setDayHourEl(hour, el)"
        class="relative flex min-h-14 border-b border-default last:border-b-0"
        :class="canWrite ? 'cursor-pointer hover:bg-elevated/50' : ''"
        @click="onHourClick(hour)"
      >
        <!-- "Now" line - only inside the CURRENT hour's own row, and
        only for today (`currentMinutePercent`'s own doc comment on why
        this is a `%` of the row's own height, not an absolute pixel
        offset). -->
        <div
          v-if="hour === currentHour && isToday(referenceDate)"
          class="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-error"
          :style="{ top: `${currentMinutePercent}%` }"
        >
          <span class="absolute top-0 left-0 block size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-error" />
        </div>

        <div class="w-16 shrink-0 border-r border-default px-2 py-1.5 text-right text-xs text-muted">
          {{ hourLabel(hour) }}
        </div>
        <div class="flex flex-1 flex-col gap-1 p-1.5">
          <div
            v-for="event in eventsAtHour(referenceDate, hour)"
            :key="event.key"
            role="button"
            tabindex="0"
            class="group flex items-center gap-2 rounded-lg border border-default px-3 py-1.5 text-left text-sm hover:border-primary/50"
            @click.stop="emit('edit', event.row)"
            @keydown.enter.space.prevent="emit('edit', event.row)"
          >
            <ColorDot :color="event.color" />
            <span
              v-if="event.timed"
              class="shrink-0 text-xs tabular-nums text-muted"
            >{{ eventTime(event) }}</span>
            <div class="flex min-w-0 flex-1 flex-col">
              <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
              <span
                v-if="richHtml[event.key]?.title"
                class="truncate font-medium text-highlighted"
                v-html="richHtml[event.key]!.title"
              />
              <!-- eslint-enable vue/no-v-html -->
              <span
                v-else
                class="truncate font-medium text-highlighted"
              >{{ event.title }}</span>
              <span
                v-if="event.description"
                class="truncate text-xs text-muted"
              >{{ event.description }}</span>
            </div>
            <UButton
              icon="i-lucide-calendar-plus"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('dataviews.calendar.addToCalendar')"
              class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              @click.stop="downloadIcs(event)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- AGENDA - every currently-loaded event, grouped by day. -->
    <div
      v-else
      class="flex flex-1 flex-col gap-4 overflow-y-auto"
    >
      <p
        v-if="agendaGroups.length === 0"
        class="py-6 text-center text-sm text-muted"
      >
        {{ t('dataviews.calendar.noEvents') }}
      </p>
      <div
        v-for="group in agendaGroups"
        :key="dayKey(group.date)"
        class="flex flex-col gap-1.5"
      >
        <p
          class="text-xs font-semibold"
          :class="isToday(group.date) ? 'text-primary' : 'text-muted'"
        >
          {{ fmt(group.date, pattern('dayHeading')) }}
        </p>
        <div
          v-for="event in group.events"
          :key="event.key"
          role="button"
          tabindex="0"
          class="group flex items-center gap-2 rounded-lg border border-default px-3 py-2 text-left text-sm hover:border-primary/50"
          @click="emit('edit', event.row)"
          @keydown.enter.space.prevent="emit('edit', event.row)"
        >
          <ColorDot :color="event.color" />
          <span
            v-if="event.timed"
            class="shrink-0 text-xs tabular-nums text-muted"
          >{{ eventTime(event) }}</span>
          <div class="flex min-w-0 flex-1 flex-col">
            <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
            <span
              v-if="richHtml[event.key]?.title"
              class="truncate font-medium text-highlighted"
              v-html="richHtml[event.key]!.title"
            />
            <!-- eslint-enable vue/no-v-html -->
            <span
              v-else
              class="truncate font-medium text-highlighted"
            >{{ event.title }}</span>
            <span
              v-if="event.description"
              class="truncate text-xs text-muted"
            >{{ event.description }}</span>
          </div>
          <UButton
            icon="i-lucide-calendar-plus"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('dataviews.calendar.addToCalendar')"
            class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            @click.stop="downloadIcs(event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
