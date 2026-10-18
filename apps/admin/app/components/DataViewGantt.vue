<script setup lang="ts">
/**
 * The `GANTT` layout's own render (DataViewGanttView.vue's own `isGantt`
 * branch) - same "dumb, receives lanes/bars already resolved" split
 * DataViewCard.vue/DataViewMap.vue/DataViewKanban.vue/DataViewCalendar.vue
 * already follow: every value shown here (lane title, bar title/
 * description/color) is resolved by the parent via the exact same
 * `useLayoutFormula` those already use (a
 * Gantt bar IS a Calendar event, just spanning a date RANGE instead of one
 * day - types/dataview.ts's own doc comment on `resolveGanttLayout`) -
 * this component only lays the timeline out and reports clicks back.
 *
 * A bar is click-to-edit, same gesture CALENDAR's own month/week chips
 * already use. With `canWrite`, dragging the bar moves it (both dates, its
 * duration kept) and its two edge handles reschedule the START or the END
 * date alone, live-previewed in whole DAYS as the pointer moves. Pointer
 * events on `window` during a drag (a mouse, a pen or a finger - no native
 * Drag and Drop API, no library) - a drag here is a continuous 1D stretch,
 * not "drop me somewhere else", so it doesn't fit either KANBAN's own DnD
 * gesture or Calendar's own whole-day drag; this component only computes
 * the final day DELTA and reports it, the actual PATCH (and how it
 * shifts the raw column value, preserving a timestamp's own time-of-day)
 * is DataViewGanttView.vue's own `onReschedule` job, same split every other
 * mutating gesture here already follows.
 *

 * One scrollable grid (both axes at once, not two synced scroll areas) -
 * the left "Task" column and the header date row are `position: sticky`
 * so they stay pinned while the other axis scrolls, a plain CSS technique
 * that needs no scroll-event wiring between two containers.
 */
import { addDays, differenceInCalendarDays, endOfMonth, format, startOfDay, startOfMonth, startOfWeek } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import { isValidColorValue, roleColorShade } from '~/types/permission'
import type { GanttZoom } from '~/types/dataview'
import type { FormulaRichSegment } from '~/utils/formula-engine'

/** `title`/`description` doc comment - same plain-text-plus-optional-rich-segments convention every other layout's own card/pin/event/chip interface already uses (KanbanCard.vue's own doc comment, word for word). */
export interface GanttBar {
  key: string
  title: string
  titleRich?: FormulaRichSegment[]
  description: string | null
  descriptionRich?: FormulaRichSegment[]
  /** A plain `string`, not `RoleColor` - same "the render layer decides valid-or-not" split CalendarEvent's own `color` doc comment already uses. */
  color: string
  start: Date
  end: Date
  /** Its progress, 0-100 (GanttLayoutConfig.progressColumn) - the bar fills up to it; null for none. */
  progress: number | null
  row: Record<string, unknown>
}
/** One row per record, always - `lanes` only ever adds an optional GROUP header above a cluster of these when `GanttLayoutConfig.groupColumn` is set (DataViewGanttView.vue's lanes); ungrouped renders a single lane with `title: null`. */
export interface GanttLane {
  key: string
  /** `null` for the single implicit lane an ungrouped board renders (`grouped` prop below) - no header row shows for it. */
  title: string | null
  /** `GanttLayoutConfig.laneColorColumn`'s own raw value off the related table's row - `null` whenever that setting is unset, or for the fixed Unassigned/ungrouped lane (neither is a real related-table row). Same plain `string` (not `RoleColor`) as `GanttBar.color` - this render layer decides valid-or-not, not the type. */
  color: string | null
  bars: GanttBar[]
}

const props = defineProps<{
  lanes: GanttLane[]
  /** Whether `GanttLayoutConfig.groupColumn` is actually set - `false` renders every bar in one flat list with no lane header rows at all, even though `lanes` itself is still a single-entry array either way (simpler for the parent than a union of two shapes). */
  grouped: boolean
  /** Gates the resize handles - a read-only viewer gets plain click-to-edit bars only, same `canWrite` gate KANBAN's own drag/CALENDAR's own drag already use. */
  canWrite: boolean
  /** The viewer's effective time zone (undefined = the browser's) - today is theirs, as the bars' dates are. */
  timezone?: string
}>()
const emit = defineEmits<{
  edit: [Record<string, unknown>]
  /** A bar's start or end edge - or the whole bar, `both` - was dragged and released a REAL (non-zero) number of days away; `deltaDays` signed (negative = earlier). */
  reschedule: [{ row: Record<string, unknown>, edge: 'start' | 'end' | 'both', deltaDays: number }]
}>()
/** Keys of the folded lanes (grouped only): just their header row, bars hidden. */
const collapsed = defineModel<string[]>('collapsed', { default: () => [] })
function toggleLane(key: string) {
  collapsed.value = collapsed.value.includes(key) ? collapsed.value.filter(k => k !== key) : [...collapsed.value, key]
}
/** A finger: the edge handles always show (no hover), and a whole bar scrolls the timeline instead of moving. */
const isTouch = useIsTouch()
/** Today in the viewer's zone. */
const today = computed(() => startOfDay(props.timezone ? toZonedTime(new Date(), props.timezone) : new Date()))

const zoom = defineModel<GanttZoom>('zoom', { required: true })
const { t } = useI18n()
const ui = useUiLocale()
/** A date in the UI's language - month and day names (date-fns). */
function fmt(date: Date, pattern: string): string {
  return format(date, pattern, { locale: ui.dateFns.value })
}
const ZOOM_OPTIONS = computed<{ value: GanttZoom, label: string }[]>(() => [
  { value: 'day', label: t('dataviews.calendar.views.day') },
  { value: 'week', label: t('dataviews.calendar.views.week') },
  { value: 'month', label: t('dataviews.calendar.views.month') }
])
/** Pixels per day at each zoom - only this (and which days get a header label, `headerGroups` below) changes between zooms; bar position/width math always stays in whole DAYS regardless. */
const PX_PER_DAY: Record<GanttZoom, number> = { day: 32, week: 10, month: 3 }
const pxPerDay = computed(() => PX_PER_DAY[zoom.value])
// The task-name column - narrower on a phone (names truncate), so the
// timeline beside it stays visible.
const isMobile = useIsMobile()
const rowLabelWidth = computed(() => (isMobile.value ? 120 : 220))

/**
 * The visible date domain - the earliest bar start through the latest bar
 * end, padded three days on each side so a bar starting/ending exactly at
 * the domain's own edge doesn't render flush against the grid's border.
 * Falls back to a plain 30-day window centered on today when there are no
 * bars at all (an empty GANTT DataView still needs SOME grid to show,
 * same "never render nothing" stance MAP's own default view takes).
 */
const domain = computed<{ start: Date, end: Date }>(() => {
  const allBars = props.lanes.flatMap(l => l.bars)
  if (allBars.length === 0) return { start: addDays(today.value, -3), end: addDays(today.value, 27) }
  const starts = allBars.map(b => b.start.getTime())
  const ends = allBars.map(b => b.end.getTime())
  return { start: addDays(startOfDay(new Date(Math.min(...starts))), -3), end: addDays(startOfDay(new Date(Math.max(...ends))), 3) }
})
const totalDays = computed(() => Math.max(1, differenceInCalendarDays(domain.value.end, domain.value.start) + 1))
const gridWidth = computed(() => rowLabelWidth.value + totalDays.value * pxPerDay.value)

/** Whole-day offset of a bar's own start/end from the domain's own start - the shared unit every positioning/header computation below is expressed in. */
function dayOffset(date: Date): number {
  return differenceInCalendarDays(startOfDay(date), domain.value.start)
}

/**
 * The active drag, if any - `deltaDays` is a LIVE preview (updated on
 * every `pointermove`, already clamped so a dragged edge can never cross
 * the other one - see `onPointerDown` below), read by `barBox` to offset
 * the edge being dragged, or both. `null`
 * whenever no drag is in progress, the common case.
 */
const dragState = ref<{ barKey: string, edge: 'start' | 'end' | 'both', deltaDays: number } | null>(null)
/** A bar's left edge and width, in pixels - with the drag in progress applied. */
function barBox(bar: GanttBar): { left: number, width: number } {
  const drag = dragState.value?.barKey === bar.key ? dragState.value : null
  const startOffset = dayOffset(bar.start) + (drag && drag.edge !== 'end' ? drag.deltaDays : 0)
  const endOffset = dayOffset(bar.end) + (drag && drag.edge !== 'start' ? drag.deltaDays : 0)
  const left = Math.max(0, startOffset) * pxPerDay.value
  return { left, width: Math.max(1, endOffset - startOffset + 1) * pxPerDay.value }
}
function barStyle(bar: GanttBar): { left: string, width: string } {
  const { left, width } = barBox(bar)
  return { left: `${left}px`, width: `${width}px` }
}
/** Its title doesn't fit in the bar (text-xs, about 6.5px a character): drawn after it instead. */
function titleOutside(bar: GanttBar): boolean {
  return barBox(bar).width < bar.title.length * 6.5 + 16
}
/**
 * A short bar's title beside it: after the bar where it fits before the timeline's end, else before the bar where
 * it fits there, else after it cut to what's left - never past the grid (B55).
 */
function outsideTitleStyle(bar: GanttBar): Record<string, string> {
  const { left, width } = barBox(bar)
  const timeline = totalDays.value * pxPerDay.value
  const needed = bar.title.length * 6.5 + 8
  const after = timeline - (left + width + 6)
  if (needed <= after) return { left: `${left + width + 6}px` }
  if (needed <= left - 6) return { right: `${timeline - left + 6}px` }
  return { left: `${left + width + 6}px`, maxWidth: `${Math.max(after, 0)}px` }
}

/**
 * Whether the mouse actually moved (by at least one whole day) during the
 * CURRENT/most recent drag - `onBarClick` below checks this to swallow
 * the native `click` a browser still fires on release when the pointer
 * ends up back over the same bar element it started on - without this,
 * every drag would ALSO pop open Edit right after. Reset at the start of
 * each new drag, not after each click - a plain click (no day moved)
 * leaves it `false`, so Edit still opens normally.
 */
let dragMoved = false
function onBarClick(bar: GanttBar) {
  if (dragMoved) {
    dragMoved = false
    return
  }
  emit('edit', bar.row)
}
/**
 * A bar (`both`) or one of its edges was pressed - tracks the pointer on
 * `window` (pointer events: a mouse, a pen or a finger; removed on release,
 * never left dangling) and turns horizontal movement into whole days with
 * the same `pxPerDay` the bars are drawn with. An edge can't cross the
 * other one - never an inverted bar, even mid-drag. A finger on the bar
 * itself scrolls the timeline (only its edges resize there).
 */
function onPointerDown(bar: GanttBar, edge: 'start' | 'end' | 'both', event: PointerEvent) {
  if (!props.canWrite || event.button !== 0) return
  if (edge === 'both' && event.pointerType === 'touch') return
  event.preventDefault()
  event.stopPropagation()
  dragMoved = false
  const startX = event.clientX
  const duration = differenceInCalendarDays(startOfDay(bar.end), startOfDay(bar.start))
  dragState.value = { barKey: bar.key, edge, deltaDays: 0 }
  function onMove(moveEvent: PointerEvent) {
    let days = Math.round((moveEvent.clientX - startX) / pxPerDay.value)
    if (edge === 'start') days = Math.min(days, duration)
    if (edge === 'end') days = Math.max(days, -duration)
    if (days !== 0) dragMoved = true
    dragState.value = { barKey: bar.key, edge, deltaDays: days }
  }
  function stop(commit: boolean) {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    const finalDays = dragState.value?.deltaDays ?? 0
    dragState.value = null
    if (commit && finalDays !== 0) emit('reschedule', { row: bar.row, edge, deltaDays: finalDays })
  }
  const onUp = () => stop(true)
  const onCancel = () => stop(false)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
}

/**
 * The header's own date labels, grouped to match the current zoom - Day
 * shows one label per day, Week groups by calendar week (Monday-first),
 * Month groups by calendar month. Each group spans its own real day
 * count (clipped at the domain's own edges) so the header stays aligned
 * with the day-based bar math above regardless of zoom.
 */
interface HeaderGroup { key: string, label: string, days: number }
const headerGroups = computed<HeaderGroup[]>(() => {
  const { start, end } = domain.value
  const groups: HeaderGroup[] = []
  let cursor = start
  while (cursor <= end) {
    if (zoom.value === 'day') {
      // A month's first day - and the first one shown - says which month it is.
      const label = cursor.getDate() === 1 || groups.length === 0 ? fmt(cursor, t('dataviews.gantt.patterns.dayStart')) : fmt(cursor, 'EEE d')
      groups.push({ key: cursor.toISOString(), label, days: 1 })
      cursor = addDays(cursor, 1)
    } else if (zoom.value === 'week') {
      const weekStart = startOfWeek(cursor, { weekStartsOn: 1 })
      const rangeStart = cursor > weekStart ? cursor : weekStart
      const weekEnd = addDays(weekStart, 6)
      const rangeEnd = weekEnd < end ? weekEnd : end
      const days = differenceInCalendarDays(rangeEnd, rangeStart) + 1
      groups.push({ key: weekStart.toISOString(), label: fmt(weekStart, t('dataviews.gantt.patterns.dayStart')), days })
      cursor = addDays(rangeEnd, 1)
    } else {
      const monthStart = startOfMonth(cursor)
      const rangeStart = cursor > monthStart ? cursor : monthStart
      const monthEnd = endOfMonth(cursor)
      const rangeEnd = monthEnd < end ? monthEnd : end
      const days = differenceInCalendarDays(rangeEnd, rangeStart) + 1
      groups.push({ key: monthStart.toISOString(), label: fmt(monthStart, t('dataviews.calendar.patterns.month')), days })
      cursor = addDays(rangeEnd, 1)
    }
  }
  return groups
})
/** The "today" marker's own left offset - omitted entirely (`null`) when today falls outside the current domain. */
const todayLeft = computed<number | null>(() => {
  if (today.value < domain.value.start || today.value > domain.value.end) return null
  return dayOffset(today.value) * pxPerDay.value
})

/** Opening the timeline, or changing its zoom: today centered in view when the tasks span it - once per zoom, never on a refetch. */
const scroller = ref<HTMLElement | null>(null)
let centeredZoom: GanttZoom | null = null
function centerToday() {
  const el = scroller.value
  const left = todayLeft.value
  // Drawn and wider than the view - before that there's nothing to scroll yet.
  if (!el || left === null || centeredZoom === zoom.value || !props.lanes.some(l => l.bars.length > 0) || el.scrollWidth <= el.clientWidth) return
  centeredZoom = zoom.value
  el.scrollLeft = Math.max(0, left - (el.clientWidth - rowLabelWidth.value) / 2)
}
watch([zoom, todayLeft, () => props.lanes], centerToday, { flush: 'post' })
onMounted(centerToday)

// Each bar's rich title/description (GanttBar's doc comment) as safe HTML, keyed by `bar.key`.
const colorMode = useColorMode()
const richHtml = useRichHtml(() => props.lanes.flatMap(lane => lane.bars))

/** Same soft, always-legible bar fill CalendarEvent's own `chipBackground` already uses - the identical `roleColorShade` static oklch table, mixed down over the page's own background so light text stays readable in both themes. */
function barBackground(color: string): string {
  const hex = roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light')
  return `color-mix(in oklab, ${hex} 28%, transparent)`
}
/** The done part of a bar - the same color, stronger. */
function progressBackground(color: string): string {
  const hex = roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light')
  return `color-mix(in oklab, ${hex} 60%, transparent)`
}
function barTooltip(bar: GanttBar): string {
  const text = bar.description ? `${bar.title} — ${bar.description}` : bar.title
  return bar.progress === null ? text : `${text} · ${bar.progress}%`
}
function barInvalidClass(color: string): string {
  return isValidColorValue(color) ? '' : 'ring-1 ring-dashed ring-error ring-inset'
}
</script>

<template>
  <div class="flex size-full min-h-96 flex-col gap-3">
    <div class="flex items-center justify-end gap-1.5">
      <UButton
        v-for="opt in ZOOM_OPTIONS"
        :key="opt.value"
        :label="opt.label"
        size="xs"
        color="neutral"
        :variant="zoom === opt.value ? 'solid' : 'outline'"
        @click="zoom = opt.value"
      />
    </div>

    <div
      ref="scroller"
      class="relative flex-1 overflow-auto rounded-lg border border-default"
    >
      <div
        class="grid"
        :style="{ gridTemplateColumns: `${rowLabelWidth}px repeat(${totalDays}, ${pxPerDay}px)`, width: `${gridWidth}px` }"
      >
        <!-- Header row - the sticky top-left corner cell, then one cell per header group (Day/Week/Month), each spanning its own real day count. -->
        <div class="sticky top-0 left-0 z-30 flex items-end border-r border-b border-default bg-elevated px-3 py-2 text-xs font-medium text-toned">
          {{ t('dataviews.gantt.task') }}
        </div>
        <div
          v-for="group in headerGroups"
          :key="group.key"
          class="sticky top-0 z-20 border-r border-b border-default bg-elevated px-2 py-2 text-center text-xs text-toned"
          :style="{ gridColumn: `span ${group.days}` }"
        >
          {{ group.label }}
        </div>

        <template v-if="lanes.length === 0 || lanes.every(l => l.bars.length === 0)">
          <div class="col-span-full flex items-center justify-center py-10 text-sm text-muted">
            {{ t('dataviews.gantt.noTasks') }}
          </div>
        </template>

        <template
          v-for="lane in lanes"
          :key="lane.key"
        >
          <!-- Lane header - a full-width row above its own bars, only when GANTT is actually grouped (`grouped` prop). `lane.color` (GanttLayoutConfig's own `laneColorColumn`) tints the row and shows a swatch, same `barBackground`/`ColorDot` treatment a bar's own color already gets - `null` (unset, or the fixed Unassigned lane) just keeps the plain `bg-elevated/70` it always had. -->
          <button
            v-if="grouped"
            type="button"
            class="z-10 py-1.5 text-left text-xs font-semibold text-highlighted"
            :class="[lane.color ? barInvalidClass(lane.color) : '', !lane.color && 'bg-elevated/70']"
            :style="{ gridColumn: '1 / -1', backgroundColor: lane.color ? barBackground(lane.color) : undefined }"
            :aria-expanded="!collapsed.includes(lane.key)"
            @click="toggleLane(lane.key)"
          >
            <!-- The row spans the timeline; its label stays at the left edge while it scrolls. -->
            <span class="sticky left-0 inline-flex items-center gap-1.5 px-3">
              <UIcon
                :name="collapsed.includes(lane.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                class="size-3.5 shrink-0 text-muted"
              />
              <ColorDot
                v-if="lane.color"
                :color="lane.color"
                size="xs"
              />
              {{ lane.title }} <span class="ml-1.5 font-normal text-toned">({{ lane.bars.length }})</span>
            </span>
          </button>

          <template
            v-for="bar in (grouped && collapsed.includes(lane.key) ? [] : lane.bars)"
            :key="bar.key"
          >
            <!-- A phone's narrow column: two lines of a smaller name, not one cut short (B55). -->
            <div
              class="sticky left-0 z-10 flex items-center border-r border-b border-default bg-default py-2 text-highlighted"
              :class="isMobile ? 'px-2 text-xs' : 'truncate px-3 text-sm'"
            >
              <UTooltip
                :text="bar.title"
                class="block w-full"
                :class="isMobile ? 'line-clamp-2 break-words' : 'truncate'"
              >
                <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
                <span
                  v-if="richHtml[bar.key]?.title"
                  :class="{ truncate: !isMobile }"
                  v-html="richHtml[bar.key]!.title"
                />
                <!-- eslint-enable vue/no-v-html -->
                <span
                  v-else
                  :class="{ truncate: !isMobile }"
                >{{ bar.title }}</span>
              </UTooltip>
            </div>
            <div
              class="relative border-b border-default"
              :style="{ gridColumn: `2 / -1` }"
            >
              <div
                v-if="todayLeft !== null"
                class="pointer-events-none absolute inset-y-0 z-[1] border-l-2 border-error/60"
                :style="{ left: `${todayLeft}px` }"
              />
              <UTooltip :text="barTooltip(bar)">
                <!-- Dragged whole, it moves (canWrite, not by a finger); clicked, it opens. -->
                <div
                  role="button"
                  tabindex="0"
                  :aria-label="barTooltip(bar)"
                  class="group absolute top-1.5 flex h-[calc(100%-0.75rem)] min-w-4 items-center gap-1.5 overflow-hidden rounded px-2 text-left text-xs hover:opacity-80"
                  :class="[barInvalidClass(bar.color), canWrite && !isTouch ? 'cursor-grab' : 'cursor-pointer', { 'ring-2 ring-primary': dragState?.barKey === bar.key }]"
                  :style="{ ...barStyle(bar), backgroundColor: barBackground(bar.color) }"
                  @pointerdown="onPointerDown(bar, 'both', $event)"
                  @click="onBarClick(bar)"
                  @keydown.enter.space.prevent="onBarClick(bar)"
                >
                  <div
                    v-if="bar.progress !== null"
                    class="pointer-events-none absolute inset-y-0 left-0"
                    :style="{ width: `${bar.progress}%`, backgroundColor: progressBackground(bar.color) }"
                  />
                  <!-- Edge handles - canWrite only; on hover with a mouse, always shown (and wider) for a finger. -->
                  <div
                    v-if="canWrite"
                    class="absolute inset-y-0 left-0 z-[1] cursor-ew-resize touch-none rounded-l"
                    :class="isTouch ? 'w-3 bg-highlighted/30' : 'w-2 opacity-0 group-hover:bg-highlighted/30 group-hover:opacity-100'"
                    @pointerdown="onPointerDown(bar, 'start', $event)"
                  />
                  <template v-if="!titleOutside(bar)">
                    <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
                    <span
                      v-if="richHtml[bar.key]?.title"
                      class="relative truncate font-medium text-highlighted"
                      v-html="richHtml[bar.key]!.title"
                    />
                    <!-- eslint-enable vue/no-v-html -->
                    <span
                      v-else
                      class="relative truncate font-medium text-highlighted"
                    >{{ bar.title }}</span>
                  </template>
                  <div
                    v-if="canWrite"
                    class="absolute inset-y-0 right-0 z-[1] cursor-ew-resize touch-none rounded-r"
                    :class="isTouch ? 'w-3 bg-highlighted/30' : 'w-2 opacity-0 group-hover:bg-highlighted/30 group-hover:opacity-100'"
                    @pointerdown="onPointerDown(bar, 'end', $event)"
                  />
                </div>
              </UTooltip>
              <!-- A short bar's title, beside it - a second way to click it; the bar is its accessible control. -->
              <button
                v-if="titleOutside(bar)"
                type="button"
                tabindex="-1"
                aria-hidden="true"
                class="absolute top-1/2 z-[2] -translate-y-1/2 truncate rounded bg-default/80 px-1 text-left text-xs font-medium whitespace-nowrap text-highlighted"
                :style="outsideTitleStyle(bar)"
                @click="emit('edit', bar.row)"
              >
                {{ bar.title }}
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
