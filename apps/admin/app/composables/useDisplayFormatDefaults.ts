/**
 * The display defaults a DataView falls back to when a field's own
 * `config.displayFormat` isn't set - the signed-in user's effective
 * timezone (their My account preferences, else Settings > General;
 * useDateTimeFormat(), from GET /auth/me); with no Format, a value reads in
 * the regional format (format-pattern.ts) - plus the
 * `dataviews.*` row caps (Settings > DataViews,
 * packages/settings/src/registry.ts). The display defaults are used by
 * both the grid (build-dataview-columns.ts) and the record form
 * (WidgetRenderer.vue/WidgetFormattedDate.vue). A field's own
 * Format always wins over them - see field-config.ts's own doc comment.
 * The row caps are the Export/Print "All matching rows" cap + warning
 * threshold (DataViewGrid.vue's own fetchAllMatchingRows) and the
 * MAP/KANBAN/CALENDAR/GANTT caps; Export and Print each get their own
 * pair (an instance may want a much higher/lower cap for a CSV/Excel
 * download than for a PDF it has to lay out client-side).
 *
 * The caps are read once and shared by every caller (a grid, its Export,
 * Print and record form are mounted together): one request in flight,
 * its answer kept until Settings > DataViews is saved
 * (`invalidateDataViewCaps`). An app user can't read /settings
 * (Administrators only): the caps then keep their registry defaults below,
 * while the display defaults come from the session for everyone.
 */
export interface DisplayFormatDefaults {
  timezone: string
}

/** Settings > DataViews, as last read - shared by every caller (the admin is an SPA: one module, one copy). */
const caps = ref<Record<string, unknown>>({})
let capsRequest: Promise<void> | null = null

/** Settings > DataViews changed: the next caller reads them again. */
export function invalidateDataViewCaps() {
  capsRequest = null
}

export function useDisplayFormatDefaults() {
  const api = useAdminApi()
  const session = useSession()
  if (session.access.value === 'ADMIN' && !capsRequest) {
    capsRequest = api.get<Record<string, unknown>>('/settings/dataviews')
      .then((r) => { caps.value = r.data })
      .catch(() => { capsRequest = null })
  }
  const data = caps
  const { timezone } = useDateTimeFormat()
  const defaults = computed<DisplayFormatDefaults>(() => ({ timezone: timezone.value ?? '' }))
  // `?? 10_000`/`?? 1_000` here match SETTINGS_DEFAULTS in
  // packages/settings/src/registry.ts - only used if this fetch hasn't
  // resolved yet (or failed), same fallback-to-default spirit as the
  // rest of this composable.
  const exportMaxRows = computed(() => Number(data.value['dataviews.export_max_rows'] ?? 10_000))
  const exportWarningThreshold = computed(() => Number(data.value['dataviews.export_warning_threshold'] ?? 1_000))
  const printMaxRows = computed(() => Number(data.value['dataviews.print_max_rows'] ?? 10_000))
  const printWarningThreshold = computed(() => Number(data.value['dataviews.print_warning_threshold'] ?? 1_000))
  // MAP DataViews' own point cap (DataViewGrid.vue's MAP branch) - see registry.ts's own doc comment on why this isn't just export_max_rows reused.
  const mapMaxPoints = computed(() => Number(data.value['dataviews.map_max_points'] ?? 500))
  // KANBAN DataViews' own card cap (DataViewGrid.vue's KANBAN branch) - same reasoning as mapMaxPoints just above, just bounding a card grid instead of pins.
  const kanbanMaxCards = computed(() => Number(data.value['dataviews.kanban_max_cards'] ?? 500))
  // CALENDAR DataViews' own event cap (DataViewGrid.vue's CALENDAR branch) - a defensive backstop, not the primary limit (the visible month's own date range already bounds the fetch) - see registry.ts's own doc comment.
  const calendarMaxEvents = computed(() => Number(data.value['dataviews.calendar_max_events'] ?? 500))
  // GANTT DataViews' own bar cap (DataViewGrid.vue's GANTT branch) - same reasoning as mapMaxPoints/kanbanMaxCards just above, just bounding a timeline instead of pins/cards.
  const ganttMaxBars = computed(() => Number(data.value['dataviews.gantt_max_bars'] ?? 500))
  // TREE DataViews' node cap - the whole hierarchy in one request (DataViewGrid.vue's TREE branch).
  const treeMaxNodes = computed(() => Number(data.value['dataviews.tree_max_nodes'] ?? 2000))
  return { defaults, exportMaxRows, exportWarningThreshold, printMaxRows, printWarningThreshold, mapMaxPoints, kanbanMaxCards, calendarMaxEvents, ganttMaxBars, treeMaxNodes }
}
