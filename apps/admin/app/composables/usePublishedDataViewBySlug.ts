import type { DataView, DataViewField } from '~/types/dataview'
import type { Ref } from 'vue'
import { resolveAutoRefresh, resolveBaseWhere, resolveCalendarLayout, resolveCardLayout, resolveDefaultState, resolveEditPresentation, resolveEditSide, resolveEditSize, resolveFeatures, resolveFormViewMode, resolveGanttLayout, resolveTreeLayout, resolveKanbanLayout, resolveMapLayout, resolveMapView, resolvePageContentAlign, resolvePageContentWidth } from '~/types/dataview'

/**
 * `useDataViewById`'s published counterpart - reads the latest publish
 * (`by-slug/:slug/published`, `:id/fields/published`), never the live
 * Studio draft (Foundations.md §13: a
 * developer editing Design/Code doesn't affect this until they hit
 * Publish). Shared by every actual consumer-facing DataView page -
 * pages/app/dataviews/[slug]/index.vue, .../new.vue, .../[pk]/edit.vue,
 * DataViewRecordPage.vue - never by a Studio editing screen (those use
 * `useDataViewById` instead, which stays on the live draft).
 */
/**
 * `draft`: the draft instead of the published version - the editor's device
 * preview frames the App with `?draft=true` (administrators only,
 * DataViews.md §12.9).
 */
export function usePublishedDataViewBySlug(slug: Ref<string>, draft: Ref<boolean> = ref(false)) {
  const api = useAppApi()
  const query = computed(() => (draft.value ? { draft: 'true' } : undefined))

  const { data: dataview, pending, error, refresh: refreshDataview } = useAsyncData(
    () => `dataview-${draft.value ? 'draft' : 'published'}-${slug.value}`,
    () => api.get<DataView>(`/dataviews/${slug.value}`, query.value).then(r => r.data),
    { watch: [slug, draft] }
  )

  const { data: fields, pending: fieldsPending, refresh: refreshFields } = useAsyncData(
    () => `dataview-${draft.value ? 'draft' : 'published'}-fields-${dataview.value?.id}`,
    () => dataview.value
      ? api.get<DataViewField[]>(`/dataviews/${slug.value}/fields`, query.value).then(r => r.data)
      : Promise.resolve([] as DataViewField[]),
    { watch: [dataview], default: () => [] }
  )

  return { dataview, fields, pending, fieldsPending, error, refreshDataview, refreshFields, ...useDataViewPresentation(dataview, fields) }
}

/**
 * Everything a DataView's layout components need, derived from one DataView
 * + its fields - shared by the published read path above and the editor's
 * read-only version preview (Foundations.md §13.7), which feeds
 * it a version's snapshot instead. `readOnly` forces `canWrite` off.
 */
export function useDataViewPresentation(
  dataview: Ref<DataView | null | undefined>,
  fields: Ref<DataViewField[] | null | undefined>,
  options: { readOnly?: boolean } = {}
) {
  // Write actions need: a TABLE source (a VIEW stays read-only regardless
  // of layout, DataViews.md §1.2) and a single-column primary key
  // (data-table-mutations.ts's own row-addressing limitation).
  const primaryKey = computed(() => {
    const pk = dataview.value?.sourceResourcePrimaryKey
    return pk && pk.length === 1 ? pk[0] : undefined
  })
  const writable = computed(() => !options.readOnly && dataview.value?.sourceResourceType === 'TABLE' && primaryKey.value !== undefined)
  // What the viewer's own grants allow (the App's `viewerActions`): editing, New, Delete each on its own.
  const canWrite = computed(() => writable.value && dataview.value?.viewerActions?.update !== false)
  const canCreate = computed(() => writable.value && dataview.value?.viewerActions?.create !== false)
  const canDelete = computed(() => writable.value && dataview.value?.viewerActions?.delete !== false)
  const features = computed(() => dataview.value ? resolveFeatures(dataview.value.viewType, dataview.value.viewConfig) : {})
  const editPresentation = computed(() => resolveEditPresentation(dataview.value?.viewConfig ?? {}))
  const editSize = computed(() => resolveEditSize(dataview.value?.viewConfig ?? {}))
  const editSide = computed(() => resolveEditSide(dataview.value?.viewConfig ?? {}))
  /** `view_config.page_content_align` - only meaningful for the `PAGE` edit-presentation's own routes (new.vue, [pk]/edit.vue), which read it to place the form left/center/right. */
  const pageContentAlign = computed(() => resolvePageContentAlign(dataview.value?.viewConfig ?? {}))
  /** `view_config.page_content_width` - how wide those same pages let the form grow. */
  const pageContentWidth = computed(() => resolvePageContentWidth(dataview.value?.viewConfig ?? {}))
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

  return { primaryKey, canWrite, canCreate, canDelete, features, editPresentation, editSize, editSide, pageContentAlign, pageContentWidth, baseWhere, autoRefresh, defaultState, formViewMode, cardLayout, mapLayout, mapView, kanbanLayout, calendarLayout, ganttLayout, treeLayout }
}
