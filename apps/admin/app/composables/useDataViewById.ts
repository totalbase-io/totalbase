import type { DataView, DataViewField } from '~/types/dataview'
import { resolveAutoRefresh, resolveBaseWhere, resolveCalendarLayout, resolveCardLayout, resolveDefaultState, resolveEditPresentation, resolveEditSide, resolveEditSize, resolveFeatures, resolveFormViewMode, resolveGanttLayout, resolveTreeLayout, resolveKanbanLayout, resolveMapLayout, resolveMapView, resolvePageContentAlign } from '~/types/dataview'

/**
 * Fetches an Admin DataView by immutable id plus its fields, and derives the handful of
 * things every page rendering it needs (write eligibility, resolved
 * features/edit_presentation) - shared by pages/dataviews/[slug].vue and
 * the `PAGE` edit-presentation's own routes (new.vue, [pk]/edit.vue) so
 * all three agree on what "this DataView" means instead of three
 * separate copies of the same useAsyncData pair.
 *
 * Reads the LIVE DRAFT (`by-slug`/`:id/fields`, unchanged) - every
 * Studio editing screen shares this, not just the Design drawer:
 * pages/dataviews/[slug]/settings.vue's own quick-edit columns table
 * patches these same live rows and must see them fresh. Actual
 * consumer-facing rendering (the TABLE/FORM/CARDS/... page a non-Studio
 * user opens) goes through `usePublishedDataViewBySlug` instead, which
 * reads the latest publish and never the draft - see its own doc
 * comment and Specification.md §13.
 */
export function useDataViewById(id: Ref<string>) {
  const api = useAdminApi()

  const { data: dataview, pending, error, refresh: refreshDataview } = useAsyncData(
    () => `dataview-${id.value}`,
    () => api.get<DataView>(`/dataviews/${id.value}`).then(r => r.data),
    { watch: [id] }
  )

  const { data: fields, pending: fieldsPending, refresh: refreshFields } = useAsyncData(
    () => `dataview-fields-${dataview.value?.id}`,
    () => dataview.value
      ? api.get<DataViewField[]>(`/dataviews/${dataview.value.id}/fields`).then(r => r.data)
      : Promise.resolve([] as DataViewField[]),
    { watch: [dataview], default: () => [] }
  )

  // Write actions need: a TABLE source (a VIEW stays read-only regardless
  // of layout, Specification_DataViews.md §1.2) and a single-column primary key
  // (data-table-mutations.ts's own row-addressing limitation).
  const primaryKey = computed(() => {
    const pk = dataview.value?.sourceResourcePrimaryKey
    return pk && pk.length === 1 ? pk[0] : undefined
  })
  const canWrite = computed(() => dataview.value?.sourceResourceType === 'TABLE' && primaryKey.value !== undefined)
  const features = computed(() => dataview.value ? resolveFeatures(dataview.value.viewType, dataview.value.viewConfig) : {})
  const editPresentation = computed(() => resolveEditPresentation(dataview.value?.viewConfig ?? {}))
  const editSize = computed(() => resolveEditSize(dataview.value?.viewConfig ?? {}))
  const editSide = computed(() => resolveEditSide(dataview.value?.viewConfig ?? {}))
  /** `view_config.page_content_align` - only meaningful for the `PAGE` edit-presentation's own routes (new.vue, [pk]/edit.vue), which read it to place the form left/center/right. */
  const pageContentAlign = computed(() => resolvePageContentAlign(dataview.value?.viewConfig ?? {}))
  /** `view_config.base_where` (types/dataview.ts's own doc comment) - fed straight into DataViewGrid's own `forcedWhere` prop. */
  const baseWhere = computed(() => resolveBaseWhere(dataview.value?.viewConfig ?? {}))
  /** `view_config.auto_refresh` - fed into DataViewGrid's own `refreshInterval` prop, same as a Detail widget's per-field setting. */
  const autoRefresh = computed(() => resolveAutoRefresh(dataview.value?.viewConfig ?? {}))
  /** `view_config.default_state` - fed into DataViewGrid's own `defaultState` prop, the fallback a first-time viewer gets instead of raw DB column order. */
  const defaultState = computed(() => resolveDefaultState(dataview.value?.viewConfig ?? {}))
  /** `view_config.form_view_mode` - FORM DataViews only (DataViewRecordPage.vue). */
  const formViewMode = computed(() => resolveFormViewMode(dataview.value?.viewConfig ?? {}))
  /** Which visible fields `RecordSearchSidebar.vue` filters on - FORM DataViews only. */
  /** `view_config.card_layout` - CARDS DataViews only, fed into DataViewGrid's own `cardLayout` prop. */
  const cardLayout = computed(() => resolveCardLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))
  /** `view_config.map_layout` - MAP DataViews only, fed into DataViewGrid's own `mapLayout` prop. */
  const mapLayout = computed(() => resolveMapLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))
  /** `view_config.map_view` - MAP DataViews only, the fixed center/zoom the map opens at. */
  const mapView = computed(() => resolveMapView(dataview.value?.viewConfig ?? {}))
  /** `view_config.kanban_layout` - KANBAN DataViews only, fed into DataViewGrid's own `kanbanLayout` prop. */
  const kanbanLayout = computed(() => resolveKanbanLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))
  /** `view_config.calendar_layout` - CALENDAR DataViews only, fed into DataViewGrid's own `calendarLayout` prop. */
  const calendarLayout = computed(() => resolveCalendarLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))
  /** `view_config.gantt_layout` - GANTT DataViews only, fed into DataViewGrid's own `ganttLayout` prop. */
  const ganttLayout = computed(() => resolveGanttLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))
  /** `view_config.tree_layout` - a TREE view's, fed into DataViewGrid's `treeLayout`. */
  const treeLayout = computed(() => resolveTreeLayout(dataview.value?.viewConfig ?? {}, fields.value ?? []))

  return { dataview, fields, pending, fieldsPending, error, refreshDataview, refreshFields, primaryKey, canWrite, features, editPresentation, editSize, editSide, pageContentAlign, baseWhere, autoRefresh, defaultState, formViewMode, cardLayout, mapLayout, mapView, kanbanLayout, calendarLayout, ganttLayout, treeLayout }
}
