import type { Ref } from 'vue'
import { addDays, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import type { CalendarLayoutConfig, CalendarViewMode } from '~/types/dataview'
import { flattenQueryObject } from '~/utils/flatten-query-object'

/**
 * A CALENDAR's own visible-range state (DataViewGrid.vue). `referenceDate`/
 * `view` are DataViewCalendar.vue's own `defineModel`s - the grid owns the
 * actual refs since the range they imply drives `rangeWhereParams`, which the
 * grid's main fetch itself needs. The rest of the CALENDAR logic is
 * DataViewCalendarView.vue.
 */
export function useGridCalendarRange(options: {
  active: () => boolean
  layout: () => CalendarLayoutConfig | undefined
  dataviewId: () => string
  /** Below md - a Month or Week default opens on Agenda (seven day columns don't fit). */
  isMobile: Ref<boolean>
  /** The viewer's time zone - the calendar's days are theirs (useLayoutFormula's dateValue). */
  timezone: Ref<string | null | undefined>
}) {
  const referenceDate = ref(options.timezone.value ? toZonedTime(new Date(), options.timezone.value) : new Date())
  const view = ref<CalendarViewMode>('month')
  /**
   * Applies `calendarLayout.defaultView` (types/dataview.ts's own doc
   * comment) the first time it's known for THIS dataview - not a plain
   * `ref(layout?.defaultView ?? 'month')` default, since `calendarLayout`
   * starts out resolved against a still-empty `viewConfig`/`fields`
   * (`useDataViewById.ts`'s own async fetch) and only reflects the real saved
   * value a moment later; not a bare watch either, which would keep stomping
   * a viewer's own later manual view-switch every time `calendarLayout`
   * recomputes for an unrelated reason. Guarded by dataviewId (same
   * one-time-per-id convention settings.vue's own `cardMapLayoutPopulatedFor`
   * uses) so a real navigation to a DIFFERENT DataView still re-applies.
   *
   * On a phone a Month or Week default opens on Agenda instead - seven day
   * columns don't fit its width. Only the starting view: switching back to
   * Month is still one tap away.
   */
  let defaultViewAppliedFor: string | null = null
  watch(() => options.layout()?.defaultView, (defaultView) => {
    if (!defaultView || defaultViewAppliedFor === options.dataviewId()) return
    defaultViewAppliedFor = options.dataviewId()
    view.value = options.isMobile.value && (defaultView === 'month' || defaultView === 'week') ? 'agenda' : defaultView
  }, { immediate: true })

  /**
   * The fetch range implied by the current view/reference date - padded to
   * whole weeks for Month (same padding DataViewCalendar.vue's own `monthDays`
   * grid uses, so a leading/trailing overflow day from the adjacent month
   * still shows its real events instead of an empty cell), a plain 7-day
   * window for Week, one day for Day, and the reference date's month for
   * Agenda. This is the CALENDAR-specific half of one decision: fetch by
   * visible range, not a flat map_max_points-style cap - re-computed (and
   * re-fetched, via `rangeWhereParams` feeding the grid's own fetch watch)
   * every time Prev/Next/Today/the view switcher changes either ref.
   */
  const range = computed<{ start: Date, end: Date } | null>(() => {
    if (!options.active()) return null
    const weekStartsOn = options.layout()?.weekStartsOn ?? 0
    if (view.value === 'month') {
      return { start: startOfWeek(startOfMonth(referenceDate.value), { weekStartsOn }), end: endOfWeek(endOfMonth(referenceDate.value), { weekStartsOn }) }
    }
    if (view.value === 'week') {
      const start = startOfWeek(referenceDate.value, { weekStartsOn })
      return { start, end: addDays(start, 6) }
    }
    if (view.value === 'day') return { start: referenceDate.value, end: referenceDate.value }
    // Agenda: the reference date's month, past days included - a calendar of past intakes is never an empty
    // "from today" list (T60).
    return { start: startOfMonth(referenceDate.value), end: endOfMonth(referenceDate.value) }
  })

  /**
   * `where[dateColumn][_gte/_lt]` - spread AFTER the grid's `whereParams`/
   * `forcedWhereParams` in the fetch so this always wins on a shared key,
   * same "the structural scoping always wins" precedent `forcedWhere` set over
   * the user's own Filter box. `_lt` the day AFTER `end` (not `_lte` on `end`
   * itself) so a timestamp column's own intra-day values on the last visible
   * day are still included, not just ones exactly at midnight.
   */
  const rangeWhereParams = computed(() => {
    const column = options.layout()?.dateColumn
    const current = range.value
    if (!column || !current) return {}
    // In date order - a day lists its events by time, and a capped range keeps its earliest.
    return { ...flattenQueryObject({ [column]: { _gte: format(current.start, 'yyyy-MM-dd'), _lt: format(addDays(current.end, 1), 'yyyy-MM-dd') } }, 'where'), order_by: column }
  })

  return { referenceDate, view, rangeWhereParams }
}
