<script setup lang="ts">
/**
 * The `TABLE` layout's grid - renders a DataView's rows through the
 * public Data API (useDataApi/useGridState), with columns built from
 * its `dataviews_fields`. Adapted from operadores-portal-v3's
 * `AppGrid.vue` (studied before writing this): kept search + a column
 * visibility/order picker + the pagination footer pattern already used
 * in security/roles/index.vue. The row-density switcher was added
 * later; the real-DOM auto-page-size measurement stays dropped -
 * polish, not correctness.
 *
 * Columns/order, sort, and density are a viewer's own DEFAULT state for
 * this DataView - auto-saved server-side per (dataview, user), not this
 * browser's localStorage (it follows the user across devices) - see
 * useGridUserPrefs.ts. Distinct from an explicit "Save view" (the bookmark
 * button's own `dataviews_saved_views`), which is a NAMED snapshot the
 * viewer chooses to keep and reapply - this is just "whatever it was
 * last left at".
 *
 * What the grid keeps for itself: the props/emits/expose contract its hosts
 * depend on, the rows' fetch and what it depends on (filter, search, caps, a
 * calendar's range), the table's columns, and the writes (a row's form, a
 * drag's PATCH, a delete). Each concern around that is its own composable
 * (useGridColumnPrefs, useGridSelection, useGridTotals, useGridLinkFilter,
 * useGridExport, useGridSavedViews, useGridCalendarRange) or child
 * (DataViewGridToolbar, DataViewGridFilterChips, DataViewGridColumnsSlideover,
 * DataViewGridDeleteModal).
 */
import type { ComponentPublicInstance } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { DATAVIEW_TYPE_META, dataviewMetaKey, PAGE_SIZE_OPTIONS, resolveFeatures, resolveHeaderAlign, type CalendarLayoutConfig, type CardLayoutConfig, type DataView, type DataViewField, type DataViewType, type EditPresentation, type EditSide, type FormSize, type GanttLayoutConfig, type GanttZoom, type TreeLayoutConfig, type KanbanLayoutConfig, type MapLayoutConfig, type MapViewConfig, type Density, DENSITY_META, type SavedView, type SavedViewConfig, type RowsChange } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDetail } from '~/types/schema'
import { regionalDatePattern, searchForApi } from '~/utils/search-terms'
import { columnValueSource } from '~/utils/column-values'
import { EMPTY_MIN_WIDTH_VAR, columnWidthVar, defaultColumnAlign, formatCellPlainText } from '~/utils/build-dataview-columns'
import { displayFieldAlias } from '~/utils/display-field'
import { displayColumns, displayText, foreignKeyDisplayFields, sortForViewer, sortKey, type DisplayConfig } from '~/utils/display-field'
import { recordMenu } from '~/utils/record-menu'
import { buildFieldsParam, collectRelationFieldRefs } from '~/utils/relation-field-refs'
import { parseConditions, serializeConditions, type Condition } from '~/utils/filterConditions'
import { flattenQueryObject } from '~/utils/flatten-query-object'
import { cardMark, conditionPlan, conditionStyleAttrs, flagsByRow, MAX_FLAGS, rowLook, type RowLook } from '~/utils/column-conditions'
import { actionFlags, actionsAt, CUSTOM_ACTION_ICON, runnableActions } from '~/utils/custom-actions'
import { selectionSum } from '~/utils/column-totals'
import { CELL_ALIGNS, GRID_CELL_TEXT_WRAPS, GRID_COLUMN_EMPTY_MIN_WIDTH, type CellStyle, type ColumnCondition, type GridCellConfig } from '@totalbase/tb-catalog'
import { parseRefreshInterval } from '~/utils/parse-refresh-interval'
import { createDashboardRefreshScheduler, type DashboardRefreshScheduler } from '~/utils/dashboard-refresh'
import { columnTitles, resolveFieldPresentation } from '~/utils/field-presentation'
import { isRoleColor, roleColorShade } from '~/types/permission'
import { useCatalogText } from '~/utils/catalog-text'
import { isToolbarMode, loadGridUserPrefs, useGridUserPrefsAutosave, type ToolbarMode, type UserPrefsConfig } from '~/composables/useGridUserPrefs'

const props = withDefaults(defineProps<{
  dataviewId: string
  /** Needed only for the PAGE presentation's routes (`/app/dataviews/:slug/new`, `/app/dataviews/:slug/:pk/edit`) - DataViewRecordPanel's overlay presentations never need it. */
  dataviewSlug: string
  /** Forwarded to DataViewRecordPanel (SQL-copy display only - not used for API routing, which is name-only now, see useDataApi.ts's own doc comment). */
  schema: string
  resourceName: string
  fields: DataViewField[]
  /** `dataview.viewType` - `undefined`/`'TABLE'` keeps the `<UTable>` this component always rendered; `'CARDS'` swaps it for a grid of `DataViewCard.vue` instead (see `isCards` below) - same toolbar/fetch/pagination/selection/delete either way, only the rows' own visual rendering differs. */
  viewType?: DataViewType
  /**
   * The views it offers (`view_config.layouts`, DataViews.md §5) - the viewer switches between them
   * in the header; each reads its own layout config (cardLayout, mapLayout...). One, or none: viewType alone.
   */
  layouts?: DataViewType[]
  /** `view_config.card_layout`, already resolved (types/dataview.ts's `resolveCardLayout`) - which visible column feeds each card's Image/Title/Description slot. Meaningless (and omitted by every caller) unless `viewType === 'CARDS'`. */
  cardLayout?: CardLayoutConfig
  /** `view_config.map_layout`, already resolved (types/dataview.ts's `resolveMapLayout`) - which visible column feeds each pin's position/popup/icon/color. Meaningless (and omitted by every caller) unless `viewType === 'MAP'`. */
  mapLayout?: MapLayoutConfig
  /** `view_config.map_view`, already resolved (types/dataview.ts's `resolveMapView`) - the fixed center/zoom the map opens at. Meaningless unless `viewType === 'MAP'`. */
  mapView?: MapViewConfig
  /** `view_config.kanban_layout`, already resolved (types/dataview.ts's `resolveKanbanLayout`) - which FK column groups records into lanes, plus which visible column feeds each card's Image/Title/Description slot. Meaningless (and omitted by every caller) unless `viewType === 'KANBAN'`. */
  kanbanLayout?: KanbanLayoutConfig
  /** `view_config.calendar_layout`, already resolved (types/dataview.ts's `resolveCalendarLayout`) - which date column places rows, plus each event chip's Title/Description/Color. Meaningless (and omitted by every caller) unless `viewType === 'CALENDAR'`. */
  calendarLayout?: CalendarLayoutConfig
  /** `view_config.gantt_layout`, already resolved (types/dataview.ts's `resolveGanttLayout`) - which Start/End date columns bound each bar, the optional FK column that groups bars into swimlanes, plus each bar's Title/Description/Color. Meaningless (and omitted by every caller) unless `viewType === 'GANTT'`. */
  ganttLayout?: GanttLayoutConfig
  /** `view_config.tree_layout`, already resolved (`resolveTreeLayout`) - the parent column, the order column and each node's formulas. Only for a TREE view. */
  treeLayout?: TreeLayoutConfig
  /** Editing a row - the viewer's UPDATE (and a writable source). */
  canWrite: boolean
  /** New, Clone and Import - the viewer's CREATE; unset, as `canWrite`. */
  canCreate?: boolean
  /** Delete, one row or the selected ones - the viewer's DELETE; unset, as `canWrite`. */
  canDelete?: boolean
  /** The New button's own label - a Detail's "New button label" (a Detail's "Add item"). Empty: "New". */
  newLabel?: string
  /** A Detail's "Paging" - off shows every row on one page (up to NO_PAGING_LIMIT) with no pager. */
  paging?: boolean
  /** Fills the height its container gives it, the rows scrolling inside under a sticky header - like the standalone page - a Detail marked Fill height on a Fit to screen form. */
  fillHeight?: boolean
  /** Keeps the row actions (Edit/Delete) pinned, opaque, at the right edge while the columns scroll sideways - a Detail control's narrow grid. Every other grid leaves them as the last ordinary column. */
  pinRowActions?: boolean
  /** Forwarded to the record form's description (DataViewRecordPanel's `note`). */
  recordFormNote?: string
  /** Required when canWrite - a single-column PK (data-table-mutations.ts's own limitation for row addressing). */
  primaryKey?: string
  /** Wizard step 5's toggles, already resolved against the type's catalog defaults (types/dataview.ts's resolveFeatures) - which of search/filter/columnsToggle/export/print/refresh/history (the `group: 'table'` half of the catalog) actually show up here; forwarded whole to DataViewRecordPanel.vue, which reads its own `group: 'form'` half (record*). */
  features: Record<string, boolean>
  /** view_config.edit_presentation, already resolved (resolveEditPresentation) - which container DataViewRecordPanel opens as, or PAGE to navigate to a dedicated route instead. */
  editPresentation: EditPresentation
  /** view_config.edit_size, already resolved (resolveEditSize) - ignored when editPresentation is PAGE. */
  editSize: FormSize
  /** view_config.edit_side, already resolved (resolveEditSide) - only meaningful when editPresentation is SIDEBAR. */
  editSide: EditSide
  /**
   * A Detail widget's own scoping filter (DataViews.md §9.7, v1: "embed an
   * existing DataView" - WidgetDataView.vue), in the same where-
   * grammar every column needs (`{ category_id: { _eq: '...' } }`, not a
   * bare value - see query-engine's own operators). Merged in AFTER the
   * user's own optional filter box
   * (`whereParams` below) so it always wins on a shared key - the
   * embedding DataView's own scoping is not something the embedded
   * grid's filter UI should be able to override. `undefined`/`{}` for
   * every other caller (the DataView's own top-level page) - no change
   * in behavior there.
   */
  forcedWhere?: Record<string, unknown>
  /** The source resource's real Postgres OID/type - needed to fetch its column catalog (`GET /catalog/table|view/:oid`) so the Filter sidebar's visual Builder can offer real per-column operators instead of the JSON-only fallback. `undefined` (a Detail, which doesn't pass it) keeps the Builder disabled there - only the standalone top-level page wires it. */
  sourceResourceOid?: number
  sourceResourceType?: 'TABLE' | 'VIEW'
  /** The DataView's own `sourceResource` (the totalbase.resources catalog id, distinct from `sourceResourceOid`'s raw Postgres OID) - RecordHistoryPanel.vue's own `resourceId`, matched against `audit_logs.resource`. `undefined` (a Detail) just keeps "View history" from finding anything, same graceful-empty behavior missing catalog access already has elsewhere. */
  sourceResourceId?: string | null
  /** `view_config.default_state` (types/dataview.ts's resolveDefaultState) - the DataView-wide fallback (columns/order, sort, density) a viewer with no personal saved state yet gets, instead of raw DB column order. `undefined` (a Detail, or a caller that omits it) just means no such fallback there. */
  defaultState?: Record<string, unknown>
  /** Values a new row starts with when created from this grid's own New - a Detail's scoping column set to the parent record (WidgetDataView.vue). An explicit `openCreate(values)` (Calendar's day click) is merged on top. */
  createDefaults?: Record<string, unknown>
  /**
   * CSS selectors for two DOM nodes in the PARENT page's own header
   * (PageHeader's action slot, `pages/app/dataviews/[slug]/index.vue`) -
   * when set AND the viewer's own toolbar mode is 'compact' (see
   * `toolbarMode` below), Search teleports to `compactSearchTarget`
   * (before New) and the "⋮" actions menu to `compactActionsTarget`
   * (after New) - so the header reads Search / New / ⋮, not
   * everything bunched to one side. Both instead of rendering in this
   * component's own toolbar row, which hides entirely in compact mode
   * (the whole row disappears, not just fewer buttons within it). `undefined` (a Detail, which has no such
   * header to move into) keeps compact mode's controls inline in this
   * component's own row instead.
   */
  compactSearchTarget?: string
  compactActionsTarget?: string
  /** The list fills its page edge to edge (list margin None): the toolbar and the pager keep a padding of their own. */
  edgeToEdge?: boolean
  /** Whether the manual "Refresh" button shows at all - a Detail widget's own config toggle ("Hide refresh"), or (the DataView's own top-level page) `features.refresh` (Edit DataView's Features tab). `undefined` (a caller that omits it entirely) defaults to shown, via `withDefaults` below. */
  showRefresh?: boolean
  /** A Grafana-style duration string ("30s", "1m", ...) or `null` (off) - a Detail widget's own "Auto-refresh" property (WidgetDataView.vue), or (the DataView's own top-level page) `view_config.auto_refresh` (Edit DataView's Features tab, resolveAutoRefresh). Either way, a viewer's own `?refresh=` URL query param always overrides it - see `refreshIntervalSource`'s own doc comment below. */
  refreshInterval?: string | null
  /** A shared saved view to apply once on load - the routed App page's `?view=<id>` ("Copy link"); its host drops the param on `sharedViewApplied`. */
  sharedView?: string
  /**
   * A link's filter (`?filter=<json>`, a dashboard's click - DataViews.md §4.10): the where grammar, applied
   * once on load on top of the DataView's filters and the viewer's permissions - even where its Filter is off (it only
   * narrows). Shown as chips with ✕; one the Data API refuses shows its error, never the rows unfiltered.
   */
  linkFilter?: string
  /**
   * 'standalone' (the DataView's own top-level page, `pages/dataviews/
   * [slug]/index.vue`) hoists "New" and bulk-selection actions up into
   * that page's PageHeader instead of rendering them in this grid's own
   * toolbar row (see `openCreate`/`selectedCount`/`requestBulkDelete`
   * below, exposed for that page to call through a template ref), and
   * turns on row-selection checkboxes + the active-filters badge row.
   * `undefined`/'embedded' (WidgetDataView.vue - no page-level header to
   * hoist into): New inline, no selection, no badges.
   */
  layout?: 'standalone' | 'embedded'
  /** The DataView's own `name`/`description` (types/dataview.ts) - Print's header block (see printPdf's own doc comment), not shown anywhere else in this component. `undefined` (a TABLE panel's child-resource control, which isn't a real DataView) prints an empty title/description rather than falling back to `resourceName`. */
  dataviewTitle?: string
  dataviewDescription?: string
  /** The DataView itself - its record form (DataViewRecordPanel.vue) mounts only with it, and its onRowSelect code hook (useDataViewController.ts). */
  dataview?: DataView | null
  /**
   * A TDataView's own toolbar (DataViews.md §9.7), fixed - not the viewer's
   * to switch: `none` keeps only New; `compact`/`full` that toolbar (a phone still
   * compact). Unset: the viewer's choice, else the DataView's, else the instance's.
   */
  embedToolbar?: 'none' | 'compact' | 'full'
  /** A TDataView's switches over the DataView's own features: a `false` turns that one off here, a `true` never turns on what the DataView has off. */
  featureMask?: Record<string, boolean>
  /** A row click reaches the host (`rowSelected`) even where it doesn't open the row (Row edit off). */
  clickableRows?: boolean
  /**
   * A TDataView's `columns`: the columns shown, in this order - over the viewer's own column prefs
   * and saved views, which still hold on the DataView's own page (never overwritten from here).
   */
  fixedColumns?: string[]
// `withDefaults` (not a plain `defineProps<T>()`) - Vue's own caveat for
// a type-only optional `boolean` prop: absent resolves to `false`, not
// `undefined`, unless a default is given here. `showRefresh`'s own doc
// comment ("`undefined` means shown") was only ever true with this
// default in place - without it, the standalone page (the one caller
// that omits the prop entirely) silently lost its Refresh button.
}>(), {
  showRefresh: true,
  paging: true,
  dataviewTitle: '',
  dataviewDescription: '',
  viewType: 'TABLE'
})

/**
 * The columns as they show (utils/field-presentation.ts, DataViews.md §15):
 * each one's own title and display options over what its resource's
 * column sets - what every layout, the export and the print read.
 */
const fields = computed(() => props.fields.map(resolveFieldPresentation))
/** A column's palette color is shaded for the viewer's mode. */
const colorMode = useColorMode()
const emit = defineEmits<{
  /** The shared saved view (`sharedView`) was applied, or couldn't be - the host stops passing it. */
  sharedViewApplied: []
  /** The link's filter (`linkFilter`) was taken - the host drops `?filter=`. */
  linkFilterApplied: []
  /** A row was created, updated, moved, deleted or imported here - which, and the rows - an embed's page reloads what it computes from them. */
  rowsChanged: [change: RowsChange]
  /** The view on screen changed (or was restored from the viewer's prefs) - the host's frame follows it (its margin). */
  layoutChange: [type: DataViewType]
  /** A row (a card, a pin, an event...) was clicked - a TDataView's Row selected. */
  rowSelected: [row: Record<string, unknown>]
  /** A row's record form opened - a TDataView's Row opened. */
  rowOpened: [row: Record<string, unknown>]
}>()

const isStandalone = computed(() => props.layout === 'standalone')
/** The standalone page's own sizing (fill the height, scroll the rows inside) - also an embedded grid marked Fill height. */
const fillsHeight = computed(() => isStandalone.value || props.fillHeight)
/** Below md (useIsMobile) - a calendar opens on Agenda (seven day columns don't fit). */
const isMobile = useIsMobile()
/** A phone or a tablet (useCompactUi) - the toolbar is always compact, like the page header it moves into. */
const isCompact = useCompactUi()
/** The view on screen: the viewer's last one among `layouts` (their prefs, below), else the DataView's viewType. */
const activeType = ref<DataViewType>(props.viewType ?? 'TABLE')
const offeredLayouts = computed<DataViewType[]>(() => {
  const list = props.layouts?.length ? [...props.layouts] : []
  return list.includes(props.viewType ?? 'TABLE') ? list : [props.viewType ?? 'TABLE', ...list]
})
const isCards = computed(() => activeType.value === 'CARDS')
const isMap = computed(() => activeType.value === 'MAP')
const isKanban = computed(() => activeType.value === 'KANBAN')
const isCalendar = computed(() => activeType.value === 'CALENDAR')
const isGantt = computed(() => activeType.value === 'GANTT')
const isTree = computed(() => activeType.value === 'TREE')
/** The active view's features - a list DataView's view_config.features holds every list type's; each view shows its own. */
const activeFeatures = computed<Record<string, boolean>>(() => {
  const own = props.dataview ? resolveFeatures(activeType.value, props.dataview.viewConfig) : props.features
  if (!props.featureMask) return own
  return Object.fromEntries(Object.entries(own).map(([key, on]) => [key, on && props.featureMask![key] !== false]))
})
/** The density switcher - a table's rows (`density`), the cards' size (`cardDensity`). */
const densitySwitcher = computed(() => !!(activeFeatures.value.density || activeFeatures.value.cardDensity))

const dataApi = useDataApi()
// What a published DataView needs at runtime (user prefs, saved views, its
// catalog, the bulk audit event) is on /app/api - reachable by every
// portal user who may open it (Security.md §8).
const appApi = useAppApi()
const toast = useToast()
const { t } = useI18n()
// A record's history is the audit log - an administrator's to read: Activity is offered only to them.
const { admin: viewer } = useSession()
const readsActivity = computed(() => viewer.value?.access === 'ADMIN')
/** The table, for its rows' semantics (`useTableRowA11y`). */
const tableEl = ref<HTMLElement | ComponentPublicInstance | null>(null)
useTableRowA11y(tableEl)
const notifyError = useErrorToast()
const catalogText = useCatalogText()
/** A density's name in the UI's language. */
const densityLabel = (density: Density) => catalogText(dataviewMetaKey('densities', density, 'label'), DENSITY_META[density].label)

// Hoisted up to the standalone page's PageHeader via a template ref -
// see this component's `layout` prop doc comment above. Declared (and
// exposed) here, before ANY top-level `await` below (the user-prefs
// fetch included), because `defineExpose` isn't allowed after one
// (vue/no-expose-after-await) - `openCreate`/`requestBulkDelete`/
// `clearSelection` are plain function declarations further down, hoisted
// the same as any other (the latter two hand over to useGridSelection,
// which only exists once the rows do), and `selectedCount` is a ref that
// composable fills in rather than the computed it'd otherwise be.
const selectedCount = ref(0)
/** The DataView's own actions for the selection (DataViews.md §3.7) - the page header's selection bar shows them. */
/** The selection's sum, for the selection bar - null without a summed column (DataViews.md §4.9). */
const selectionSummary = ref<string | null>(null)
const selectionActions = ref<{ label: string, icon: string, color?: 'neutral' | 'primary' | 'success' | 'warning' | 'error', onSelect: () => void }[]>([])
defineExpose({ openCreate, requestBulkDelete, clearSelection, selectedCount, selectionActions, selectionSummary })

// --- User prefs (columns/order, sort, density...) - fetched once, up front,
// so the initial render already reflects them and so their `sort` can seed
// useGridState's own initial value below (useGridUserPrefs.ts). Falls back
// to the DataView's own `defaultState` (someone's own "Set as default for
// everyone", see the Saved views popover) when this viewer has never had
// anything personally saved yet - and only then to the raw DB column order
// every prop already handles on its own.
const userPrefsConfig: UserPrefsConfig = await loadGridUserPrefs(props.dataviewId, props.defaultState)
// The viewer's last view, while the DataView still offers it.
if (userPrefsConfig.layout && offeredLayouts.value.includes(userPrefsConfig.layout)) activeType.value = userPrefsConfig.layout

// 20 - the DataView grid's own default page size, distinct from the
// 25-ish default other admin list pages use elsewhere in the app.
// Overridden by the viewer's own saved `pageSize` (the "Rows per page"
// select next to pagination below), same follow-across-devices prefs
// every other grid setting here already gets. With no sort saved
// anywhere (or an empty one - older prefs autosaved "unsorted"), the
// primary key ascending: the default the DataView's settings page shows,
// and a stable order to page through.
// A saved page size off the select's own scale (a view's cap, once written
// here) falls back to 20. A viewer's prefs without a sort take the
// DataView's default one before the primary key (B54).
const savedPageSize = userPrefsConfig.pageSize
const defaultSort = userPrefsConfig.sort || (props.defaultState as UserPrefsConfig | undefined)?.sort
const { page, pageSize, search, debouncedSearch, sort, params, toggleSort, sortDirection } = useGridState({ pageSize: savedPageSize && PAGE_SIZE_OPTIONS.includes(savedPageSize) ? savedPageSize : 20, sort: defaultSort ? sortForViewer(defaultSort, fields.value) : props.primaryKey })

// --- Filter (features.filter) - reuses WhereField. The visual condition
// Builder popover only turns on once `filterColumns` resolves (below) -
// a caller that doesn't pass `sourceResourceOid` (a Detail) keeps the
// JSON-only fallback.
const filterOpen = ref(false)
/** The column a header's "Filter by this column…" opens the Filter panel's builder on. */
const filterColumn = ref<string>()
const whereText = ref('')
/** A link's filter (`linkFilter`), taken once - its chips, and its error when it isn't a filter object. */
const link = useGridLinkFilter({ linkFilter: props.linkFilter, dataviewId: () => props.dataviewId, fields, onApplied: () => emit('linkFilterApplied') })
const whereParams = computed(() => {
  let own: Record<string, unknown> | null = null
  if (activeFeatures.value.filter && whereText.value.trim()) {
    try {
      own = JSON.parse(whereText.value) as Record<string, unknown>
    } catch {
      own = null
    }
  }
  // The link's filter narrows on top of the viewer's own - both hold.
  const where = link.linkWhere.value && own ? { _and: [link.linkWhere.value, own] } : (link.linkWhere.value ?? own)
  return where ? flattenQueryObject(where, 'where') : {}
})

// Best-effort decomposition of the current where JSON into removable
// chips for the standalone page's "active filters" badge row below the
// toolbar - null means "too complex to break apart" (a nested group
// written by hand), same rule WhereField.vue's own Builder popover
// already follows; that case falls back to one generic badge that
// clears the whole thing instead of per-condition ones.
const filterGroup = computed(() => parseConditions(whereText.value))
const filterConditions = computed(() => filterGroup.value?.conditions ?? null)

/**
 * The filter's chips read a picked value as the viewer would: a foreign key's by its row presentation (read once
 * per value from its table, `field=value` keyed), a CHECK value by its label - never the bare key. `in` lists each.
 */
const PICKED_OPERATORS: readonly string[] = ['_eq', '_neq', '_in']
const filterValueLabels = reactive<Record<string, string>>({})
watch(filterConditions, async (conditions) => {
  const wanted = new Map<string, Set<string>>()
  for (const condition of conditions ?? []) {
    if (!PICKED_OPERATORS.includes(condition.operator) || typeof condition.value !== 'string') continue
    const values = condition.value.split(',').filter(v => v !== '' && !(`${condition.field}=${v}` in filterValueLabels))
    if (values.length) wanted.set(condition.field, new Set([...(wanted.get(condition.field) ?? []), ...values]))
  }
  await Promise.all([...wanted].map(async ([column, values]) => {
    const field = fields.value.find(f => f.columnName === column)
    const source = field ? columnValueSource(field) : undefined
    if (source?.kind !== 'relation') return
    const shown = displayColumns(source.display)
    try {
      const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(source.schema, source.table, 'table'), {
        fields: [...new Set([source.column, ...shown])].join(','),
        [`where[${source.column}][_in]`]: [...values].join(','),
        limit: values.size
      })
      for (const row of data) {
        const label = displayText(source.display, c => row[c])
        if (label) filterValueLabels[`${column}=${String(row[source.column])}`] = label
      }
    } catch {
      // The key shows instead.
    }
  }))
}, { immediate: true })
/** A picked value's text (each of an `in`'s), or undefined when it isn't one or has no label to show. */
function filterValueText(condition: Condition): string | undefined {
  if (!PICKED_OPERATORS.includes(condition.operator) || typeof condition.value !== 'string') return undefined
  const options = (fields.value.find(f => f.columnName === condition.field)?.config as { options?: Record<string, { label?: string }> } | undefined)?.options
  const values = condition.value.split(',')
  const shown = values.map(v => filterValueLabels[`${condition.field}=${v}`] ?? options?.[v]?.label ?? v)
  return shown.some((label, i) => label !== values[i]) ? shown.join(', ') : undefined
}
function filterChipText(condition: Condition): string {
  const shown = filterValueText(condition)
  return link.linkChipText(shown === undefined ? condition : { ...condition, value: shown })
}
function removeFilterCondition(index: number) {
  if (!filterGroup.value) return
  whereText.value = serializeConditions(filterGroup.value.conditions.filter((_, i) => i !== index), filterGroup.value.join)
}

// Print's header block - the same conditions the active-filters badge row
// shows, joined into one plain-language line instead of separate chips (a
// PDF has no per-chip remove button to justify keeping them apart).
// `filterGroup` null (a hand-written expression too complex to break into
// chips) still has an active filter worth mentioning, just not one this can
// summarize term-by-term.
const printFilterSummary = computed(() => {
  if (!whereText.value.trim()) return ''
  if (!filterGroup.value || filterGroup.value.conditions.length === 0) return t('dataviews.history.customFilter')
  return filterGroup.value.conditions
    .map(filterChipText)
    .join(` ${filterGroup.value.join.toUpperCase()} `)
})

// Catalog columns for the Filter sidebar's Builder - fetched lazily the
// first time the sidebar opens, not eagerly on mount: most page loads never open Filter at all. KANBAN/
// GANTT are the exceptions (`isKanban`/`isGantt` in the trigger below) -
// KANBAN needs this SAME relationDetail eagerly, up front, to know the
// groupColumn's own FK target (schema/table/pk, for the lane fetch in
// DataViewKanbanView.vue) and NOT NULL-ness (for the Unassigned lane's
// own `droppable`); GANTT needs the same FK target for its own
// (optional) lanes in DataViewGanttView.vue, whenever a groupColumn is
// actually mapped.
const relationDetail = ref<RelationDetail | null>(null)
/**
 * The Filter's Builder offers the DataView's own columns - what it reads
 * (DataViews.md §4), not every column of the
 * table - and its related ones by path (`producto.codigo`), typed by the
 * catalog's `relatedColumns`: the Data API filters on a path as on a column.
 */
const filterColumns = computed<CatalogColumn[] | undefined>(() => {
  const detail = relationDetail.value as (RelationDetail & { relatedColumns?: Record<string, string> }) | null
  if (!detail) return undefined
  // Each one titled as its grid column is (resolveFieldPresentation's label).
  const titleOf = new Map(fields.value.filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName).map(f => [f.columnName!, f.label ?? f.columnName!]))
  const related = fields.value
    .filter(f => f.kind === 'RELATED' && f.columnName && detail.relatedColumns?.[f.columnName])
    .map((f): CatalogColumn => ({ attnum: 0, name: f.columnName!, dataType: detail.relatedColumns![f.columnName!]!, nullable: true, isIdentity: false, isGenerated: false, defaultExpression: null }))
  // A foreign key's or a CHECK list's possible values - the Builder's `=`, `≠` and `in` pick from them.
  const checkValues = (detail as { checkValues?: Record<string, string[]> }).checkValues ?? {}
  const fieldOf = new Map(fields.value.filter(f => f.columnName).map(f => [f.columnName!, f]))
  return [...detail.columns.filter(c => titleOf.has(c.name)), ...related].map((c) => {
    const field = fieldOf.get(c.name)
    const values = field ? columnValueSource(field, checkValues[c.name]) : undefined
    return { ...c, label: titleOf.get(c.name), ...(values ? { values } : {}) }
  })
})
watch([filterOpen, isKanban, isGantt], async ([open, kanban, gantt]) => {
  if ((!open && !kanban && !gantt) || relationDetail.value || !props.sourceResourceOid) return
  try {
    const res = await appApi.get<RelationDetail>(`/dataviews/${props.dataviewId}/catalog`)
    relationDetail.value = res.data
  } catch {
    // Best-effort - the Builder just stays disabled (JSON editor only),
    // same as every caller that never passes sourceResourceOid. KANBAN
    // just renders with no lanes (Unassigned only) in this case.
  }
}, { immediate: true })

/**
 * Table-level history (right of the Saved views bookmark) - the SAME RecordHistoryPanel.vue sidebar as
 * the record form's own per-row "Activity", just without `pk-value`
 * so it isn't filtered to one row: every row's history for this
 * resource, INCLUDING ones already deleted (a deleted row has nowhere
 * left to open its own per-row panel from - that one only exists while
 * the row itself still does).
 */
const tableHistoryOpen = ref(false)
/** The table's history panel mounts the first time it opens (its own audit read) - not on every grid. */
const tableHistoryOpened = useOpenedOnce(tableHistoryOpen)
function openTableHistory() {
  tableHistoryOpen.value = true
}

// --- Saved views (features.savedViews, DataViews.md §5.9) - useGridSavedViews owns the open view and
// the writes; the grid captures and applies the state (its filter, columns, sort,
// density and view).
function applySavedView(config: SavedViewConfig) {
  whereText.value = config.where ? JSON.stringify(config.where, null, 2) : ''
  if (config.columnPrefs && !props.fixedColumns?.length) colPrefs.prefs = { ...config.columnPrefs }
  if (typeof config.sort === 'string') sort.value = sortForViewer(config.sort, fields.value)
  if (config.density) densityPrefs.value = config.density
  if (config.layout && offeredLayouts.value.includes(config.layout)) activeType.value = config.layout
}
function captureView(): SavedViewConfig | { error: string } {
  let where: Record<string, unknown> | null = null
  if (whereText.value.trim()) {
    try {
      where = JSON.parse(whereText.value)
    } catch {
      return { error: t('dataviews.grid.invalidFilterJson') }
    }
  }
  return { where, columnPrefs: colPrefs.prefs, sort: sort.value, density: densityPrefs.value, layout: activeType.value }
}
const views = useGridSavedViews({
  dataviewId: () => props.dataviewId,
  enabled: !!activeFeatures.value.savedViews,
  initialViewId: userPrefsConfig.savedView,
  whereText,
  capture: captureView,
  apply: applySavedView,
  defaultState: () => props.defaultState,
  viewType: () => props.viewType ?? 'TABLE'
})
const { savedViews, activeViewId, effectiveDefaultState } = views

// --- Filter › Save as view: the filter's quick way to a saved view - the whole state on screen, as the views menu's
// Save current view (SaveViewForm, which asks before replacing one of one's own by its name). ---
const saveFilterOpen = ref(false)
/** Named after its filter, as its chips read it - cut to what a name may hold (32). */
const filterViewName = computed(() => {
  const summary = (filterConditions.value ?? []).map(filterChipText).join(', ')
  return summary.length > 32 ? `${summary.slice(0, 31).trimEnd()}…` : summary
})
watch(() => views.savingView.value, (now, before) => {
  if (before && !now) saveFilterOpen.value = false
})

// --- A saved view's Share (the views menu's people icon): who sees it - its dialog, mounted once asked. ---
const shareViewOpen = ref(false)
const shareViewOpened = useOpenedOnce(shareViewOpen)
const shareViewTarget = ref<SavedView | null>(null)
function openShareView(id: string) {
  shareViewTarget.value = savedViews.views.value.find(v => v.id === id) ?? null
  if (shareViewTarget.value) shareViewOpen.value = true
}

const forcedWhereParams = computed(() =>
  props.forcedWhere && Object.keys(props.forcedWhere).length ? flattenQueryObject(props.forcedWhere, 'where') : {}
)

/**
 * The `fields` param every row read sends (buildFieldsParam): the
 * DataView's columns - shown or hidden, a column in the DataView is always
 * read and one not in it never is (DataViews.md §4.1)
 * - the primary key, and one joined alias per foreign key
 * display_field and per `{{fk.related}}` reference in a formula (a field's
 * bindings, and the Card/Map/Kanban/Calendar/Gantt layouts' formulas,
 * which live in `view_config`). With `fields`, the Data API's search stays
 * within these columns too.
 */
const fieldsParam = computed<string>(() => {
  // Not an FK whose display column the viewer may not read (`display_field_denied`, app-dataviews.ts) - it shows the raw key.
  const fkFields = foreignKeyDisplayFields(fields.value)
  // Every related column its display reads - one, or its template's (`{{name}} ({{country}})`).
  const displayFieldAliases = fkFields.flatMap(f => displayColumns(f.config as DisplayConfig).map(c => displayFieldAlias(f.columnName!, c)))
  const relationRefs = collectRelationFieldRefs(fields.value, [
    props.cardLayout?.titleFormula, props.cardLayout?.descriptionFormula, props.cardLayout?.imageFormula,
    props.mapLayout?.nameFormula, props.mapLayout?.descriptionFormula, props.mapLayout?.iconFormula, props.mapLayout?.colorFormula,
    props.kanbanLayout?.titleFormula, props.kanbanLayout?.descriptionFormula, props.kanbanLayout?.imageFormula,
    props.calendarLayout?.titleFormula, props.calendarLayout?.descriptionFormula, props.calendarLayout?.colorFormula,
    props.ganttLayout?.titleFormula, props.ganttLayout?.descriptionFormula, props.ganttLayout?.colorFormula,
    props.treeLayout?.titleFormula, props.treeLayout?.descriptionFormula, props.treeLayout?.iconFormula, props.treeLayout?.colorFormula, props.treeLayout?.imageFormula
  ])
    // Never one the viewer may not read (`deniedRelationPaths`, app-dataviews.ts): the Data API would refuse every row.
    .filter(ref => !props.dataview?.deniedRelationPaths?.includes(`${ref.column}.${ref.relatedColumn}`))
  return buildFieldsParam(fields.value, props.primaryKey, relationRefs, displayFieldAliases)
})

// --- CALENDAR's own visible-range state (useGridCalendarRange) - the grid owns the refs since the range they imply
// drives the main fetch below. The rest of the CALENDAR logic is DataViewCalendarView.vue.
const { timezone: viewerTimezone } = useDateTimeFormat()
const { referenceDate: calendarReferenceDate, view: calendarView, rangeWhereParams: calendarRangeWhereParams } = useGridCalendarRange({
  active: () => isCalendar.value,
  layout: () => props.calendarLayout,
  dataviewId: () => props.dataviewId,
  isMobile,
  timezone: viewerTimezone
})

// The caps and paging below set `pageSize` before the first fetch: a board,
// a map, a calendar, a timeline or an unpaged Detail asks once, for all its
// rows - not a page of 20 and then the rest.
const {
  defaults: displayFormatDefaults,
  exportMaxRows: EXPORT_ALL_CAP,
  exportWarningThreshold: EXPORT_WARNING_THRESHOLD,
  printMaxRows: PRINT_ALL_CAP,
  printWarningThreshold: PRINT_WARNING_THRESHOLD,
  mapMaxPoints: MAP_MAX_POINTS,
  kanbanMaxCards: KANBAN_MAX_CARDS,
  calendarMaxEvents: CALENDAR_MAX_EVENTS,
  ganttMaxBars: GANTT_MAX_BARS,
  treeMaxNodes: TREE_MAX_NODES
} = useDisplayFormatDefaults()

// MAP, KANBAN, CALENDAR and GANTT have no pager: each asks once for every
// relevant row, up to its instance-wide cap (DataViews.md
// §5.11, `dataviews.map_max_points` ...) - a CALENDAR's request is already
// bounded by its visible range, the cap its backstop. The cap is that
// view's own `limit`, never written into `pageSize`: the viewer's page size
// is the TABLE's and CARDS', saved with their prefs, and switching from a
// board back to the table keeps it (B48, B53). `total > limit` is each
// view's "showing the first N of M" notice. Still bounded server-side by
// `api.max_limit` like any single request.
const capLimit = computed<number | null>(() => {
  if (isMap.value) return MAP_MAX_POINTS.value
  if (isKanban.value) return KANBAN_MAX_CARDS.value
  if (isCalendar.value) return CALENDAR_MAX_EVENTS.value
  if (isGantt.value) return GANTT_MAX_BARS.value
  if (isTree.value) return TREE_MAX_NODES.value
  return null
})
/** The list request's paging: the grid's page, or a capped view's one request from the first row. */
const fetchParams = computed(() => (capLimit.value ? { ...params.value, limit: capLimit.value, offset: 0 } : params.value))

// Paging off (a Detail's own option, a Detail's default): every row at
// once, one request - the Data API's default `api.max_limit`. Were there
// ever more, the pager comes back rather than hiding rows silently.
const NO_PAGING_LIMIT = 500
watch(() => props.paging, (paging) => {
  if (!paging) pageSize.value = NO_PAGING_LIMIT
}, { immediate: true })

/** Reads go to the source's own route - a view is `/view/`, never `/table/` (writes only ever target a table). */
const sourceKind = computed(() => (props.sourceResourceType === 'VIEW' ? 'view' : 'table'))
/** The source's own Data API path, for every read (the rows, the totals, an export). */
const sourcePath = () => dataApi.resourcePath(props.schema, props.resourceName, sourceKind.value)

/** A Gantt's bars by start date - a capped timeline keeps its earliest tasks, not arbitrary ones. */
const ganttOrderParams = computed(() => (isGantt.value && props.ganttLayout?.startDateColumn ? { order_by: props.ganttLayout.startDateColumn } : {}))

/**
 * Conditional formatting (DataViews.md §15.7): the shown columns' conditions, sent as `flags` - PostgreSQL
 * answers which each row meets (`meta.flags`); the grid only paints it.
 */
/** The DataView's own actions this viewer may run (DataViews.md §3.7) - a row's shown where its condition holds, a flag too. */
const runnable = computed(() => runnableActions(props.dataview?.viewConfig, props.dataview?.actionTargets))
const rowActionFlags = computed(() => actionFlags(runnable.value, ['row']))
const conditionPlanned = computed(() => conditionPlan(fields.value
  .filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.visible && f.columnName)
  .map(f => ({ column: f.columnName!, conditions: (f.config as { conditions?: ColumnCondition[] }).conditions })), MAX_FLAGS - Object.keys(rowActionFlags.value).length))
const flagParams = computed(() => {
  const flags = { ...rowActionFlags.value, ...conditionPlanned.value.flags }
  return Object.keys(flags).length ? flattenQueryObject(flags, 'flags') : {}
})

/**
 * What narrows the list's rows - its filter (the viewer's, the DataView's and an embed's link, a calendar's range)
 * and its search, with the fields it reads - a search looks in exactly those: the DataView's columns, shown or
 * hidden, a foreign key by what it shows (Data_API.md §3.5, DataViews.md §4.6), a
 * day typed as the viewer sees it sent as ISO. The rows and the totals at its foot are read with exactly this.
 */
const listFilterParams = computed<Record<string, string>>(() => ({
  ...whereParams.value,
  ...forcedWhereParams.value,
  ...calendarRangeWhereParams.value,
  ...(typeof fetchParams.value.search === 'string' && fetchParams.value.search ? { search: searchForApi(fetchParams.value.search, regionalDatePattern()), fields: fieldsParam.value } : {})
}))

const { data, pending, error, refresh } = await useAsyncData(
  () => `dataview-rows-${props.dataviewId}-${JSON.stringify(fetchParams.value)}-${JSON.stringify(whereParams.value)}-${JSON.stringify(forcedWhereParams.value)}-${JSON.stringify(calendarRangeWhereParams.value)}-${JSON.stringify(ganttOrderParams.value)}-${JSON.stringify(flagParams.value)}`,
  // A link's filter that isn't one: its error, never the rows unfiltered.
  () => link.linkFilterError.value
    ? Promise.reject(new Error(link.linkFilterError.value))
    : dataApi.get<Record<string, unknown>[]>(
        sourcePath(),
        {
          ...fetchParams.value,
          ...listFilterParams.value,
          ...ganttOrderParams.value,
          ...flagParams.value,
          fields: fieldsParam.value
        } as unknown as Record<string, unknown>
      ),
  { watch: [fetchParams, whereParams, forcedWhereParams, calendarRangeWhereParams, ganttOrderParams, flagParams], default: () => ({ data: [] as Record<string, unknown>[] }) }
)

// --- Auto-refresh - the dashboards' own scheduler (dashboard-refresh.ts)
// re-calling the same `refresh()` the toolbar's own button uses, no
// separate fetch path: counted from the end of the previous run, and
// paused while the browser tab is hidden (a grid left open in a
// background tab polled all day; once visible again it refreshes at once
// if a run fell due meanwhile).
// `refreshInterval` is this DataView's own default: a Detail widget's
// own "Auto-refresh" (WidgetDataView.vue), or - for the DataView's own
// top-level page - `view_config.auto_refresh` (Edit DataView's Features
// tab, resolveAutoRefresh). Either way, a viewer's own `?refresh=1m`-
// style URL query param (Grafana-style, see parse-refresh-interval.ts's
// own doc comment) always wins when present - it's a per-visit override
// of whatever default this DataView was configured with, not the other
// way around.
const route = useRoute()
/** Whichever raw duration string is actually in effect - the URL query param when present, else the prop - for the toolbar's own "Refresh (auto 1m)" label below. */
const refreshIntervalSource = computed(() => {
  const urlValue = route.query.refresh as string | string[] | undefined
  return urlValue !== undefined ? urlValue : (props.refreshInterval ?? undefined)
})
const refreshIntervalMs = computed(() => parseRefreshInterval(refreshIntervalSource.value))
const refreshLabel = computed(() => (refreshIntervalMs.value ? t('dataviews.grid.refreshAuto', { interval: refreshIntervalSource.value }) : t('common.refresh')))
let refreshScheduler: DashboardRefreshScheduler | undefined
watch(refreshIntervalMs, (ms) => {
  refreshScheduler?.stop()
  refreshScheduler = ms ? createDashboardRefreshScheduler({ intervalMs: ms, run: () => refresh() }) : undefined
  refreshScheduler?.start()
}, { immediate: true })
onUnmounted(() => refreshScheduler?.stop())

// A saved view applied via link ("Copy link" in the Share modal) - `?view=<id>`, applied once on this load; its host
// drops the param right after.
if (props.sharedView) views.applySharedView(props.sharedView, () => emit('sharedViewApplied'))

const rows = computed(() => data.value?.data ?? [])
/** Runs one of the DataView's own actions; done, what shows reloads - and the page's record (rowsChanged). */
const customActions = useCustomActions({
  primaryKey: () => props.primaryKey ?? null,
  onDone: () => {
    clearSelection()
    void refresh()
    emit('rowsChanged', { action: 'update', rows: [] })
  }
})
/** The flags PostgreSQL said each row meets - by the raw row, as cells and menus get it. */
const rowFlags = computed(() => {
  const met = flagsByRow(rows.value, (data.value as { meta?: { flags?: string[][] } })?.meta?.flags)
  const byRaw = new WeakMap<Record<string, unknown>, string[]>()
  for (const row of rows.value) byRaw.set(toRaw(row), met.get(row) ?? [])
  return byRaw
})
/** Each row's look - the conditions PostgreSQL said it meets, by row. */
const rowLooks = computed(() => {
  const met = flagsByRow(rows.value, (data.value as { meta?: { flags?: string[][] } })?.meta?.flags)
  // By the raw row - the table hands its cells the rows without Vue's proxy.
  const looks = new WeakMap<Record<string, unknown>, RowLook>()
  for (const row of rows.value) looks.set(toRaw(row), rowLook(met.get(row), conditionPlanned.value))
  return looks
})
function lookOf(row: Record<string, unknown>): RowLook | undefined {
  return rowLooks.value.get(toRaw(row))
}
const shadeColor = (color: string) => (isRoleColor(color) ? roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light') : undefined)
function rowAttrs(row: Record<string, unknown>) {
  const look = lookOf(row)?.row
  return look ? conditionStyleAttrs(look, shadeColor) : undefined
}
/** A row a condition holds for: its look on the whole row (`tr`). */
const rowMeta = computed(() => ({
  class: { tr: (row: { original: Record<string, unknown> }) => rowAttrs(row.original)?.class ?? '' },
  style: { tr: (row: { original: Record<string, unknown> }) => rowAttrs(row.original)?.style ?? {} }
}))
const total = computed(() => (data.value as { meta?: { count?: number } })?.meta?.count ?? rows.value.length)

// --- Column visibility/order (useGridColumnPrefs) - part of the auto-saved user prefs, seeded from
// `userPrefsConfig.columnPrefs`; kept in sync going forward by the autosave further down.
const columnPrefs = useGridColumnPrefs({
  fields,
  rawFields: () => props.fields,
  fixedColumns: () => props.fixedColumns,
  initial: userPrefsConfig.columnPrefs,
  defaultState: () => effectiveDefaultState.value
})
const { colPrefs, orderedFields, colsOpen, hiddenColCount } = columnPrefs

// --- A column's width, dragged at its header's right edge (DataViews.md §5.2, §5.9) - with a mouse; a finger scrolls.
const isTouch = useIsTouch()
const COLUMN_WIDTH = { min: 48, max: 2000 }
/** The table element, where each column's width variable lives (build-dataview-columns.ts's `columnWidthVar`). */
function tableRoot(): HTMLElement | null {
  const el = tableEl.value
  return el instanceof HTMLElement ? el : ((el as ComponentPublicInstance | null)?.$el as HTMLElement | undefined) ?? null
}
// The viewer's widths, as the variables the headers and cells read - set again whenever their preferences change
// (a column whose width is gone - Reset width, a view applied - drops its variable).
const widthVars = new Set<string>()
watch([tableEl, () => colPrefs.prefs], () => {
  const root = tableRoot()
  if (!root) return
  const now = new Set<string>()
  for (const [key, pref] of Object.entries(colPrefs.prefs)) {
    if (pref.width === undefined) continue
    root.style.setProperty(columnWidthVar(key), `${pref.width}px`)
    now.add(key)
  }
  for (const key of widthVars) if (!now.has(key)) root.style.removeProperty(columnWidthVar(key))
  widthVars.clear()
  now.forEach(key => widthVars.add(key))
}, { immediate: true, flush: 'post' })
// --- A column moved by dragging its header (useGridColumnDrag, DataViews.md §5.2) - a plain click still opens its menu.
const columnDrag = useGridColumnDrag({
  root: tableRoot,
  keys: () => orderedFields.value.map(f => f.columnName!),
  place: (key, before) => columnPrefs.placeColumn(key, before)
})
// No rows: no content sizes the columns, so each one with no minimum of its own takes GRID_COLUMN_EMPTY_MIN_WIDTH.
watch([tableEl, () => rows.value.length === 0], ([, empty]) => {
  const root = tableRoot()
  if (!root) return
  if (empty) root.style.setProperty(EMPTY_MIN_WIDTH_VAR, `${GRID_COLUMN_EMPTY_MIN_WIDTH}px`)
  else root.style.removeProperty(EMPTY_MIN_WIDTH_VAR)
}, { immediate: true, flush: 'post' })
/** Drags column `key`'s width: the variable follows the pointer (no cell drawn again), its preference is kept on release. */
function startColumnResize(key: string, event: PointerEvent) {
  const root = tableRoot()
  const box = root?.querySelector<HTMLElement>(`[data-col-box="${CSS.escape(key)}"]`)
  if (!root || !box) return
  event.preventDefault()
  // The edge stays primary while dragged, the pointer off it.
  const edge = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  edge?.setAttribute('data-resizing', '')
  const startX = event.clientX
  const startWidth = box.getBoundingClientRect().width
  let width = startWidth
  const onMove = (move: PointerEvent) => {
    width = Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, startWidth + move.clientX - startX))
    root.style.setProperty(columnWidthVar(key), `${width}px`)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.removeProperty('cursor')
    edge?.removeAttribute('data-resizing')
    if (width !== startWidth) columnPrefs.setWidth(key, width)
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

/**
 * A column header's menu (DataViews.md §5.2): its sort, its place and its text for this viewer (their prefs, like
 * the Columns menu), and for an administrator the column's panel in Settings.
 */
function headerMenu(field: DataViewField): DropdownMenuItem[][] {
  const key = field.columnName!
  const by = sortKey(field)
  const direction = sortDirection(by)
  const columnWrap = (field.config as GridCellConfig).textWrap ?? 'truncate'
  // Its column's alignment (DataViews.md §15), else its type's (§4.3, defaultColumnAlign).
  const columnAlign = (field.config as CellStyle).align ?? defaultColumnAlign(field)
  const own = columnPrefs.cellPrefOf(key)
  const wrap = own.textWrap ?? columnWrap
  const align = own.align ?? columnAlign
  const groups: DropdownMenuItem[][] = [[
    { label: t('dataviews.grid.sortAscending'), icon: 'i-lucide-arrow-up-narrow-wide', type: 'checkbox', checked: direction === 'asc', onSelect: () => { sort.value = by } },
    { label: t('dataviews.grid.sortDescending'), icon: 'i-lucide-arrow-down-wide-narrow', type: 'checkbox', checked: direction === 'desc', onSelect: () => { sort.value = `-${by}` } },
    ...(direction ? [{ label: t('dataviews.grid.clearSort'), icon: 'i-lucide-x', onSelect: () => { sort.value = '' } }] : [])
  ]]
  if (activeFeatures.value.filter) {
    groups[0]!.push({ label: t('dataviews.grid.filterByColumn'), icon: 'i-lucide-filter', onSelect: () => {
      filterColumn.value = key
      filterOpen.value = true
    } })
  }
  if (activeFeatures.value.columnsToggle) {
    groups.push([{ label: t('dataviews.grid.hideColumn'), icon: 'i-lucide-eye-off', disabled: orderedFields.value.length <= 1, onSelect: () => columnPrefs.hideColumn(key) }])
  }
  groups.push(CELL_ALIGNS.map(option => ({
    label: t(`dataviews.grid.align.${option}`),
    icon: `i-lucide-align-${option}`,
    type: 'checkbox' as const,
    checked: align === option,
    onSelect: () => columnPrefs.setCellPref(key, 'align', option, columnAlign)
  })))
  groups.push(GRID_CELL_TEXT_WRAPS.map(option => ({
    label: t(option === 'truncate' ? 'dataviews.grid.oneLine' : 'dataviews.grid.severalLines'),
    icon: option === 'truncate' ? 'i-lucide-text-cursor' : 'i-lucide-wrap-text',
    type: 'checkbox' as const,
    checked: wrap === option,
    onSelect: () => columnPrefs.setCellPref(key, 'textWrap', option, columnWrap)
  })))
  if (colPrefs.prefs[key]?.width !== undefined) {
    groups.push([{ label: t('dataviews.grid.resetWidth'), icon: 'i-lucide-move-horizontal', onSelect: () => columnPrefs.setWidth(key, undefined) }])
  }
  if (readsActivity.value && field.kind !== 'WIDGET') {
    groups.push([{ label: t('dataviews.grid.editColumn'), icon: 'i-lucide-settings-2', to: { path: `/dataviews/${props.dataviewId}/settings`, query: { section: 'data', column: key } } }])
  }
  return groups
}

// --- Edit form (create/edit a row) ---
const formOpen = ref(false)
// The form (and its widgets) loads on first open, then stays mounted so it can animate closed and reopen at once.
const formMounted = useOpenedOnce(formOpen)
const formMode = ref<'create' | 'edit' | 'view'>('create')
const editingRow = ref<Record<string, unknown> | null>(null)
/** CALENDAR's own "click an empty day" gesture (DataViewCalendarView.vue's `create` event) - forwarded to DataViewRecordPanel's own `initialValues` prop (record-engine.ts's own doc comment). `undefined` for every other caller (a plain "New" button/keyboard shortcut) - create-mode seeding is then untouched, exactly as before this existed. */
const createInitialValues = ref<Record<string, unknown> | undefined>(undefined)

function openCreate(explicitValues?: Record<string, unknown>) {
  const initialValues = props.createDefaults || explicitValues ? { ...props.createDefaults, ...explicitValues } : undefined
  if (props.editPresentation === 'PAGE') {
    // `?initial.<column>=<value>` per key (flatten-query-object.ts's own
    // convention, just a different prefix than `where`/`having`) - the
    // ONLY way to carry a value across a real route change into
    // pages/app/dataviews/[slug]/new.vue, which mounts fresh with no access
    // to this component's own in-memory state.
    const query = initialValues ? flattenQueryObject(initialValues, 'initial') : {}
    navigateTo({ path: `/app/dataviews/${props.dataviewSlug}/new`, query })
    return
  }
  formMode.value = 'create'
  editingRow.value = null
  createInitialValues.value = initialValues
  formOpen.value = true
}
function openEdit(row: Record<string, unknown>, selected = false) {
  if (!selected) emit('rowSelected', row)
  emit('rowOpened', row)
  if (props.editPresentation === 'PAGE') {
    if (!props.primaryKey) return
    navigateTo(`/app/dataviews/${props.dataviewSlug}/${encodeURIComponent(String(row[props.primaryKey]))}/edit`)
    return
  }
  // No write access (a read-only preview) but a row to address: the same
  // form, read-only, so the record's layout can still be looked at.
  formMode.value = props.canWrite ? 'edit' : 'view'
  editingRow.value = row
  formOpen.value = true
}
function onSaved(row: Record<string, unknown>) {
  refresh()
  emit('rowsChanged', { action: formMode.value === 'create' ? 'create' : 'update', rows: [row] })
}
function onDeleted() {
  refresh()
  emit('rowsChanged', { action: 'delete', rows: editingRow.value ? [editingRow.value] : [] })
}

// --- Delete confirmation ---
const dropTarget = ref<Record<string, unknown> | null>(null)
const dropping = ref(false)
async function confirmDrop() {
  if (!dropTarget.value || !props.primaryKey) return
  dropping.value = true
  try {
    await dataApi.del(dataApi.resourcePath(props.schema, props.resourceName, 'table', String(dropTarget.value[props.primaryKey])))
    toast.add({ title: t('dataviews.grid.rowDeleted'), color: 'success' })
    emit('rowsChanged', { action: 'delete', rows: [dropTarget.value] })
    dropTarget.value = null
    await refresh()
  } catch (err) {
    notifyError(err, t('dataviews.grid.deleteRowError'))
  } finally {
    dropping.value = false
  }
}

/** New, Clone, Import - and Delete: the viewer's own CREATE and DELETE, else whatever `canWrite` says. */
const mayCreate = computed(() => props.canCreate ?? props.canWrite)
const mayDelete = computed(() => props.canDelete ?? props.canWrite)

// --- Row selection (standalone layout) and its bulk delete - useGridSelection (DataViews.md §5.15). ---
/** Edit the chosen rows together - wherever a row may be edited: the role may update and Allow has Edit. */
const mayBulkEdit = computed(() => isStandalone.value && !!props.canWrite && !!props.primaryKey && props.sourceResourceType !== 'VIEW')
/** The most rows a viewer may choose - dataviews.bulk_edit_max_rows, where they may be edited together. */
const selectionCap = computed(() => (mayBulkEdit.value ? props.dataview?.bulkEditMaxRows ?? 100 : Number.POSITIVE_INFINITY))
const selection = useGridSelection({
  rows,
  primaryKey: () => props.primaryKey,
  selectionCap: () => selectionCap.value,
  schema: () => props.schema,
  resourceName: () => props.resourceName,
  refresh,
  onRowsChanged: change => emit('rowsChanged', change),
  selectedCount
})
const { rowSelection, selectedRows, atSelectionCap, toggleRowSelected } = selection
/** The hosting page's header "✕" / Clear selection (PageHeader's `selection`) - exposed above. */
function clearSelection() {
  selection.clearSelection()
}
/** The hosting page's bulk Delete - exposed above. */
function requestBulkDelete() {
  selection.requestBulkDelete()
}
const bulkEditOpen = ref(false)
const hasSelectionActions = computed(() => mayBulkEdit.value || actionsAt(runnable.value, 'selection').length > 0)
/** The selection's own actions, for the page header's selection bar. */
watch([runnable, mayBulkEdit, selectedCount], ([list]) => {
  selectionActions.value = [
    ...(mayBulkEdit.value ? [{ label: t('dataviews.bulkEdit.edit'), icon: 'i-lucide-pencil', onSelect: () => { bulkEditOpen.value = true } }] : []),
    ...actionsAt(list, 'selection').map(r => ({ label: r.action.label, icon: r.action.icon ?? CUSTOM_ACTION_ICON, color: r.action.color, onSelect: () => void customActions.run(r, selectedRows.value) }))
  ]
}, { immediate: true })

const showPager = computed(() => props.paging || total.value > pageSize.value)

// --- Copy to clipboard (`config.copyable`, field-config.ts) - a switch
// the builder can flip on any field; this is just the actual
// clipboard write + user feedback, build-dataview-columns.ts only
// hands back which text to copy.
function copyCellText(text: string) {
  if (!text) return
  navigator.clipboard?.writeText(text).then(() => {
    toast.add({ title: t('dataviews.grid.copied'), color: 'success' })
  }).catch(() => {
    toast.add({ title: t('dataviews.grid.copyError'), color: 'error' })
  })
}

// --- CARDS/MAP/KANBAN/CALENDAR/GANTT - each its own lazy view
// (DataView<Type>View.vue), which turns `rows` into cards/pins/lanes/
// events/bars through the layout's formulas and emits edits back here.
// The grid keeps what the fetch depends on (calendar range, page caps)
// and the writes.

/**
 * GANTT's zoom - applied from `GanttLayoutConfig.defaultZoom` once per
 * dataview (same guard as the calendar's default view), so a later
 * `ganttLayout` recompute never stomps the viewer's own zoom change.
 */
const ganttZoom = ref<GanttZoom>('day')
let ganttDefaultZoomAppliedFor: string | null = null
watch(() => props.ganttLayout?.defaultZoom, (zoom) => {
  if (!zoom || ganttDefaultZoomAppliedFor === props.dataviewId) return
  ganttDefaultZoomAppliedFor = props.dataviewId
  ganttZoom.value = zoom
}, { immediate: true })

/**
 * A drag on a board/calendar/timeline (a card to another lane, an event
 * to another day, a bar's edge) - the same Data API PATCH the Edit form
 * makes, never a bespoke endpoint; then a refetch. A failed move just
 * snaps back on the next render.
 */
/** A TREE node moved: its parent, then its new siblings' order - one PATCH each, in order, then one refetch. */
async function updateRows(changes: { row: Record<string, unknown>, data: Record<string, unknown> }[]) {
  if (!props.primaryKey || !props.canWrite) return
  try {
    for (const { row, data } of changes) {
      await dataApi.patch<Record<string, unknown>>(dataApi.resourcePath(props.schema, props.resourceName, 'table', String(row[props.primaryKey])), { data })
    }
    emit('rowsChanged', { action: 'update', rows: changes.map(c => ({ ...c.row, ...c.data })) })
  } catch (err) {
    notifyError(err, t('dataviews.treeView.moveError'))
  }
  await refresh()
}

async function updateRow({ row, data, errorTitle }: { row: Record<string, unknown>, data: Record<string, unknown>, errorTitle: string }) {
  if (!props.primaryKey || !props.canWrite) return
  try {
    await dataApi.patch<Record<string, unknown>>(
      dataApi.resourcePath(props.schema, props.resourceName, 'table', String(row[props.primaryKey])),
      { data }
    )
    emit('rowsChanged', { action: 'update', rows: [{ ...row, ...data }] })
    await refresh()
  } catch (err) {
    notifyError(err, errorTitle)
  }
}

// --- A row's "⋮": the record's own menu (utils/record-menu.ts), as in its form's header ---

const rowOutputs = useRecordOutputs({
  dataview: computed(() => props.dataview ?? ({ name: props.dataviewTitle ?? '', description: props.dataviewDescription ?? null } as DataView)),
  fields
})
/** The row whose Activity is open - its own record-mode panel, beside the table-wide one. */
const activityPk = ref<string | null>(null)
function rowMenu(row: Record<string, unknown>): DropdownMenuItem[][] {
  const pk = props.primaryKey ? row[props.primaryKey] : undefined
  const saved = pk !== null && pk !== undefined
  return recordMenu({
    custom: saved
      ? actionsAt(runnable.value, 'row', rowFlags.value.get(toRaw(row))).map(r => ({ label: r.action.label, icon: r.action.icon ?? CUSTOM_ACTION_ICON, color: r.action.color, onSelect: () => void customActions.run(r, [row]) }))
      : undefined,
    // A copy to finish and save: its values, not its key - PostgreSQL gives the new one.
    clone: mayCreate.value && activeFeatures.value.recordClone && props.primaryKey
      ? () => openCreate(Object.fromEntries(Object.entries(row).filter(([key]) => key !== props.primaryKey)))
      : undefined,
    copy: activeFeatures.value.recordCopy ? () => void rowOutputs.copy(row) : undefined,
    print: activeFeatures.value.recordPrint ? () => void rowOutputs.print(row, pk) : undefined,
    activity: readsActivity.value && activeFeatures.value.recordHistory && props.sourceResourceId && saved ? () => (activityPk.value = String(pk)) : undefined,
    delete: mayDelete.value ? () => { dropTarget.value = row } : undefined
  }, t)
}

// --- Totals (DataViews.md §4.9, useGridTotals) - the TABLE's foot, and the selection's sum. ---
const { totalsPlanned, totalText } = useGridTotals({
  active: () => activeType.value === 'TABLE',
  orderedFields,
  path: sourcePath,
  listFilterParams,
  fetchParams,
  data,
  displayFormatDefaults
})
/** The selection's sum of the first summed column - beside its count in the selection bar. */
watch(selectedRows, (list) => {
  const summed = totalsPlanned.value.find(e => e.kind === 'sum')
  const field = summed ? orderedFields.value.find(f => f.columnName === summed.column) : undefined
  const sum = summed && list.length ? selectionSum(list, summed.column) : null
  const sumText = sum !== null && field ? t('dataviews.totals.selectionSum', { label: field.label ?? field.columnName, value: formatCellPlainText(field, sum, {}, displayFormatDefaults.value) }) : null
  // At the cap, why the other boxes can't be ticked.
  const capText = atSelectionCap.value ? t('dataviews.bulkEdit.atCap', { n: selectionCap.value }) : null
  selectionSummary.value = [sumText, capText].filter(Boolean).join(' · ') || null
})

/** The table's columns as UTable draws them (useGridTableColumns): the DataView's with their totals, the selection checkbox, the pinned ones. */
const { tableColumns, columnPinning } = useGridTableColumns({
  orderedFields,
  sortDirection,
  onToggleSort: toggleSort,
  rowMenu,
  onCopy: copyCellText,
  displayFormatDefaults,
  shade: shadeColor,
  cellLook: (row, column) => lookOf(row)?.cells[column],
  headerMenu,
  cellPrefFor: field => columnPrefs.cellPrefOf(field.columnName!),
  onResizeStart: (key, event) => startColumnResize(key, event),
  onResizeReset: key => columnPrefs.setWidth(key, undefined),
  resizable: () => !isTouch.value,
  onReorderStart: (key, event) => columnDrag.start(key, event),
  reorderable: () => !isTouch.value && !!activeFeatures.value.columnsToggle,
  headerAlign: () => resolveHeaderAlign(props.dataview?.viewConfig),
  totalsPlanned,
  totalText,
  pinRowActions: () => !!props.pinRowActions,
  selectable: () => isStandalone.value && (mayDelete.value || hasSelectionActions.value),
  atSelectionCap: () => atSelectionCap.value,
  isMobile
})

// --- Row density - part of the same auto-saved user prefs as
// `colPrefs` (DENSITY_META, types/dataview.ts).
const densityPrefs = reactive({ value: userPrefsConfig.density ?? ('normal' as Density) })
const densityItems = computed(() => (['normal', 'compact', 'tiny'] as const).map(key => ({
  label: densityLabel(key),
  type: 'checkbox' as const,
  checked: densityPrefs.value === key,
  onSelect: () => { densityPrefs.value = key }
})))
// --- Row edit (features.rowEdit) - click anywhere on a row to open its
// edit form, same `openEdit` the actions column's own pencil button
// already calls. Bound to UTable's own `:on-select` only when enabled
// (`undefined` otherwise, in the template below) - passing `on-select`
// at all is what turns on the theme's own row-hover highlight
// (`data-selectable`), so it must stay off entirely when the feature
// is off, not just no-op inside the handler. UTable's own `onSelect`
// plumbing (Table.vue) already excludes clicks landing on a `<button>`/
// `<a>` before calling this, so the actions column's Edit/Delete
// buttons and the sort-header buttons never double-fire it - same
// reason build-dataview-columns.ts's own `linkType`/`copyable` cells
// already call `stopPropagation()` on their own click, written before
// this feature existed but exactly for this. `canWrite` only - same
// gate the actions column's pencil button already needs (openEdit
// requires a real row to edit). Mirrors ResourcesBrowser.vue's own
// `:on-select` pattern (the Tables screen).
const rowEditEnabled = computed(() => (props.canWrite || !!props.primaryKey) && !!activeFeatures.value.rowEdit)
function onRowSelect(_event: Event, row: { original: Record<string, unknown> }) {
  emit('rowSelected', row.original)
  if (rowEditEnabled.value) openEdit(row.original, true)
}

const tableUi = computed(() => ({
  td: DENSITY_META[densityPrefs.value].td,
  th: DENSITY_META[densityPrefs.value].th,
  // The theme's own `data-selectable` hover highlight comes for free
  // once `:on-select` is bound below - it just doesn't include a
  // pointer cursor, so that part needs adding here.
  tr: rowEditEnabled.value ? 'cursor-pointer' : undefined
}))

// --- Toolbar mode (DataViewGridToolbar.vue) - 'full' (every action its own
// button, today's default) or 'compact' (Search/Actions/New only, the rest in
// one "⋮"). Same auto-saved user prefs as columns/sort/density, so a viewer's
// choice follows them across devices too, per-DataView (some DataViews get
// used heavily, some barely - one global switch would be too blunt). The
// toggle itself lives inside the "⋮", not as its own permanent button.
// Which toolbar a viewer opens with (DataViews.md §5): their own saved
// choice; else the DataView's (`default_state.toolbarMode`); else the instance's
// (Settings > DataViews > Toolbar, sent with the DataView); else compact, every
// type (Search and the "⋮" in the page header - the admin's own shape). A phone
// or tablet is compact whatever this says (below).
// Only the viewer's own toggle is saved as theirs - never the default they were shown, so a
// DataView or instance default changed later still reaches whoever hasn't chosen.
const toolbarChoice = ref<ToolbarMode | undefined>(isToolbarMode(userPrefsConfig.toolbarMode) ? userPrefsConfig.toolbarMode : undefined)
const toolbarMode = computed<ToolbarMode>(() =>
  (props.embedToolbar && props.embedToolbar !== 'none' ? props.embedToolbar : undefined)
  ?? [toolbarChoice.value, props.defaultState?.toolbarMode, props.dataview?.instanceToolbarMode].find(isToolbarMode)
  ?? 'compact')
function toggleToolbarMode() {
  toolbarChoice.value = toolbarMode.value === 'full' ? 'compact' : 'full'
}
// A phone or tablet always gets compact - like the phone-style page header
// its Search and "⋮" move into. Only what's shown: the viewer's saved
// preference stays as it is, for their desktop.
const effectiveToolbarMode = computed<ToolbarMode>(() => (isCompact.value ? 'compact' : toolbarMode.value))
/** Compact mode's controls move into the standalone page's own header (the toolbar's Teleports) rather than shrinking within this component's own toolbar row - only when there's actually a target to move them into (a Detail never passes one, and keeps rendering them inline). */
const toolbarTeleport = computed(() => (isStandalone.value && effectiveToolbarMode.value === 'compact' && props.compactSearchTarget && props.compactActionsTarget
  ? { search: props.compactSearchTarget, actions: props.compactActionsTarget }
  : undefined))

// Debounced auto-save of the prefs above (columns/order, sort, density,
// toolbar mode, page size...) back to the server (useGridUserPrefs.ts).
// A Kanban's collapsed lanes (their keys), kept like the rest of the viewer's prefs.
const collapsedLanes = ref<string[]>(userPrefsConfig.collapsedLanes ?? [])
useGridUserPrefsAutosave(
  () => props.dataviewId,
  [() => colPrefs.prefs, sort, () => densityPrefs.value, toolbarChoice, pageSize, collapsedLanes, activeType, activeViewId],
  // An embed's own columns are never saved as the viewer's - their prefs stay as they were.
  () => ({ columnPrefs: props.fixedColumns?.length ? userPrefsConfig.columnPrefs : colPrefs.prefs, sort: sort.value, density: densityPrefs.value, ...(toolbarChoice.value && { toolbarMode: toolbarChoice.value }), pageSize: pageSize.value, collapsedLanes: collapsedLanes.value, ...(offeredLayouts.value.length > 1 && { layout: activeType.value }), savedView: activeViewId.value })
)

// --- Views (DataViews.md §5): the switcher - the toolbar's icon buttons, or the "⋮"'s View on a phone. ---
const layoutOptions = computed(() => offeredLayouts.value.map(type => ({ type, label: catalogText(`dataviews.meta.types.${type}.label`, DATAVIEW_TYPE_META[type].label), icon: DATAVIEW_TYPE_META[type].icon })))
function switchLayout(type: DataViewType) {
  if (type === activeType.value) return
  activeType.value = type
}
// Each view reads its own way (a calendar by its range, a board by lanes) - read again on a switch.
watch([activeType, capLimit], ([type, cap], [, previousCap]) => {
  emit('layoutChange', type)
  // A new cap changes the request itself, which refetches on its own.
  if (cap === previousCap) void refresh()
})
emit('layoutChange', activeType.value)

// --- Export / Print / Import - their own panels (DataViewExportSlideover/
// DataViewPrintSlideover/DataViewImportSlideover), loaded the first time one
// is opened; the grid only owns the query they read from and the bulk audit
// event they report (useGridExport).
const { fetchAllMatchingRows, logBulkAuditEvent } = useGridExport({
  path: sourcePath,
  whereParams,
  forcedWhereParams,
  fieldsParam,
  sort,
  debouncedSearch,
  whereText,
  sourceResourceId: () => props.sourceResourceId
})
const exportOpen = ref(false)
const exportOpened = useOpenedOnce(exportOpen)
const printOpen = ref(false)
const printOpened = useOpenedOnce(printOpen)
const importOpen = ref(false)
const importOpened = useOpenedOnce(importOpen)
async function onImported(created: number) {
  void logBulkAuditEvent('IMPORT', created, 'csv')
  emit('rowsChanged', { action: 'import', rows: [] })
  await refresh()
}
</script>

<template>
  <!-- Standalone only: fills whatever height the page hands it (see
  pages/app/dataviews/[slug]/index.vue) and pins the count+pagination footer
  to the bottom of that space via `flex-1 min-h-0` on the scrollable
  middle section below - the toolbar/badges/footer never move, only the
  table area between them scrolls. Embedded (panels) keeps the old
  natural-height behavior: no fixed area to pin a footer against, and a
  panel growing with its content is the right call there.

  `$attrs.class` explicitly, not Vue's automatic fallthrough: this
  component's actual template has many sibling nodes after this div
  (every USlideover/UModal below) - a multi-root component, where Vue
  disables automatic attrs inheritance entirely since it can't guess
  which root should receive them. Without this, the standalone page's
  own `class="min-h-0 flex-1"` on `<DataViewGrid>` (needed for this div
  to actually respect `h-full` instead of just sizing to its own content)
  was silently dropped - the "double scrollbar" bug traced back to exactly this. -->
  <div :class="[fillsHeight ? 'flex h-full w-full flex-col gap-4' : 'flex w-full flex-col gap-4', $attrs.class]">
    <!-- The toolbar row - or, compact on the standalone page, its controls teleported into the page header. -->
    <DataViewGridToolbar
      v-model:search="search"
      :mode="effectiveToolbarMode"
      :new-only="embedToolbar === 'none'"
      :teleport="toolbarTeleport"
      :show-new="mayCreate && !isStandalone"
      :new-label="newLabel"
      :edge-to-edge="edgeToEdge"
      :features="activeFeatures"
      :views="savedViews.views.value"
      :active-view-id="activeViewId"
      :view-saving="views.savingView.value"
      :layouts="layoutOptions"
      :active-layout="activeType"
      :has-history="readsActivity && !!sourceResourceId && !!activeFeatures.history"
      :density-switcher="densitySwitcher"
      :density-items="densityItems"
      :density-label="densityLabel(densityPrefs.value)"
      :filter-active="!!whereText.trim()"
      :hidden-col-count="hiddenColCount"
      :can-import="mayCreate && !!activeFeatures.import"
      :show-refresh="showRefresh"
      :refresh-label="refreshLabel"
      :toolbar-mode="toolbarMode"
      :can-toggle-toolbar="!isCompact && !embedToolbar"
      @create="openCreate()"
      @select-view="views.selectSavedView"
      @switch-layout="switchLayout"
      @save-new-view="views.saveNewView"
      @replace-view="views.replaceSavedView"
      @remove-view="views.removeSavedView"
      @share-view="openShareView"
      @open-history="openTableHistory"
      @open-filter="filterOpen = true"
      @open-columns="colsOpen = true"
      @open-import="importOpen = true"
      @open-export="exportOpen = true"
      @open-print="printOpen = true"
      @refresh="() => refresh()"
      @toggle-toolbar-mode="toggleToolbarMode"
    />

    <!-- Scrollable middle section - only this part scrolls in standalone
    layout (min-h-0 is what lets a flex child actually shrink below its
    content's natural height and hand scrolling to overflow-y-auto
    instead of growing the page); embedded panels get no wrapper at all,
    same markup as before this pass. -->
    <div :class="fillsHeight ? 'flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto' : 'contents'">
      <!-- A link's filter and, standalone only, the active filter - as removable chips. -->
      <DataViewGridFilterChips
        :link-group="link.linkGroup.value"
        :has-link-filter="!!link.linkWhere.value"
        :link-chip-text="link.linkChipText"
        :show-filter="isStandalone && !!activeFeatures.filter && !!whereText.trim()"
        :filter-conditions="filterConditions"
        :filter-chip-text="filterChipText"
        @remove-link="link.removeLinkCondition"
        @clear-link="link.clearLinkFilter"
        @remove-filter="removeFilterCondition"
        @clear-filter="whereText = ''"
      />

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

      <!-- CARDS/MAP/KANBAN/CALENDAR/GANTT - one lazy view each; the
      boards/calendars/timelines have no pager and no selection, so
      `limit` doubles as the cap their notice reports. -->
      <LazyDataViewCardsView
        v-if="isCards"
        :rows="rows"
        :fields="fields"
        :layout="cardLayout"
        :density="densitySwitcher ? densityPrefs.value : 'normal'"
        :primary-key="primaryKey"
        :row-menu="rowMenu"
        :mark-of="(row: Record<string, unknown>) => cardMark(lookOf(row)?.row, shadeColor)"
        :selectable="isStandalone && (mayDelete || hasSelectionActions)"
        :selection="rowSelection"
        :pending="pending"
        @edit="openEdit"
        @toggle-select="toggleRowSelected"
      />
      <LazyDataViewMapView
        v-else-if="isMap"
        :rows="rows"
        :fields="fields"
        :layout="mapLayout"
        :map-view="mapView"
        :primary-key="primaryKey"
        :total="total"
        :limit="capLimit ?? pageSize"
        @edit="openEdit"
      />
      <LazyDataViewKanbanView
        v-else-if="isKanban"
        v-model:collapsed-lanes="collapsedLanes"
        :mark-of="(row: Record<string, unknown>) => cardMark(lookOf(row)?.row, shadeColor)"
        :rows="rows"
        :fields="fields"
        :layout="kanbanLayout"
        :relations="relationDetail?.relations"
        :catalog-columns="relationDetail?.columns"
        :check-values="(relationDetail as { checkValues?: Record<string, string[]> } | null)?.checkValues"
        :primary-key="primaryKey"
        :can-write="canWrite"
        :total="total"
        :limit="capLimit ?? pageSize"
        @edit="openEdit"
        @update-row="updateRow"
      />
      <LazyDataViewCalendarView
        v-else-if="isCalendar"
        v-model:view="calendarView"
        v-model:reference-date="calendarReferenceDate"
        :rows="rows"
        :fields="fields"
        :layout="calendarLayout"
        :primary-key="primaryKey"
        :can-write="canWrite"
        :timezone="viewerTimezone"
        :pending="pending"
        :total="total"
        :limit="capLimit ?? pageSize"
        @edit="openEdit"
        @create="openCreate"
        @update-row="updateRow"
      />
      <LazyDataViewGanttView
        v-else-if="isGantt"
        v-model:zoom="ganttZoom"
        v-model:collapsed-lanes="collapsedLanes"
        :rows="rows"
        :fields="fields"
        :layout="ganttLayout"
        :relations="relationDetail?.relations"
        :primary-key="primaryKey"
        :can-write="canWrite"
        :total="total"
        :limit="capLimit ?? pageSize"
        :timezone="viewerTimezone"
        @edit="openEdit"
        @update-row="updateRow"
      />
      <LazyDataViewTreeView
        v-else-if="isTree"
        :rows="rows"
        :fields="fields"
        :layout="treeLayout"
        :primary-key="primaryKey"
        :dataview-id="dataviewId"
        :can-write="canWrite"
        :can-create="mayCreate"
        :row-menu="rowMenu"
        :total="total"
        :limit="capLimit ?? pageSize"
        @edit="openEdit"
        @create="openCreate"
        @update-rows="updateRows"
      />
      <UTable
        v-else
        ref="tableEl"
        v-model:row-selection="rowSelection"
        sticky
        :data="rows"
        :columns="tableColumns"
        :loading="pending"
        :ui="tableUi"
        :on-select="rowEditEnabled || clickableRows ? onRowSelect : undefined"
        :column-pinning="columnPinning"
        :meta="rowMeta"
        :class="fillsHeight ? 'w-full h-full' : 'w-full'"
      >
        <template #empty>
          <UEmpty
            variant="naked"
            size="sm"
            icon="i-lucide-inbox"
            :title="t('dataviews.layouts.noRows')"
          />
        </template>
      </UTable>
    </div>

    <div
      v-if="!isMap && !isKanban && !isCalendar && !isGantt && !isTree && showPager"
      class="flex shrink-0 border-t border-default pt-3"
      :class="edgeToEdge ? 'px-3 pb-3' : undefined"
    >
      <!-- The page size is persisted alongside the rest of this viewer's
      own grid prefs (columns/sort/density/toolbar mode) - see
      useGridUserPrefs.ts; changing it resets to page 1 (useGridState's own watch). -->
      <TablePager
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-size-options="PAGE_SIZE_OPTIONS"
        class="w-full"
      />
    </div>
  </div>

  <!-- A saved view's Share - opened from its row in the views popover. -->
  <LazyDataViewShareViewModal
    v-if="shareViewOpened"
    v-model:open="shareViewOpen"
    :dataview-id="dataviewId"
    :dataview-slug="dataviewSlug"
    :view="shareViewTarget"
    @shared-count="(delta: number) => shareViewTarget && savedViews.setSharedCount(shareViewTarget.id, delta)"
  />

  <DataViewGridColumnsSlideover
    v-model:open="colsOpen"
    :items="columnPrefs.listItems.value"
    :has-default="columnPrefs.hasDefaultColsState.value"
    @set-all="columnPrefs.setAllColsVisible"
    @select-default="columnPrefs.selectDefaultCols"
    @toggle="columnPrefs.toggleColVisible"
    @move-up="columnPrefs.moveUp"
    @move-down="columnPrefs.moveDown"
  />

  <USlideover
    v-model:open="filterOpen"
    :title="t('dataviews.meta.featureLabels.filter')"
  >
    <template #body>
      <div class="flex h-full flex-col gap-4">
        <WhereField
          v-model="whereText"
          :label="t('dataviews.grid.condition')"
          :description="t('dataviews.grid.conditionDescription')"
          min-height="14rem"
          :columns="filterColumns"
          :value-text="filterValueText"
          :default-field="filterColumn"
          default-mode="simple"
        />
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          class="mt-auto"
          :title="t('dataviews.grid.filterHelpTitle')"
          :description="t('dataviews.grid.filterHelpDescription')"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center gap-2">
        <!-- The filter as a saved view - all of what's on screen, as the views menu's New view. -->
        <UPopover
          v-if="activeFeatures.savedViews && whereText.trim()"
          v-model:open="saveFilterOpen"
        >
          <UButton
            :label="t('dataviews.grid.saveFilterAsView')"
            icon="i-lucide-bookmark-plus"
            color="neutral"
            variant="outline"
          />
          <template #content>
            <SaveViewForm
              class="w-80 p-3"
              :views="savedViews.views.value"
              :default-name="filterViewName"
              :saving="views.savingView.value"
              @save="views.saveNewView"
              @replace="views.replaceSavedView"
              @cancel="saveFilterOpen = false"
            />
          </template>
        </UPopover>
        <div class="flex-1" />
        <UButton
          :label="t('common.clear')"
          color="neutral"
          variant="ghost"
          :disabled="!whereText.trim()"
          @click="whereText = ''"
        />
        <UButton
          :label="t('common.close')"
          color="neutral"
          variant="outline"
          @click="filterOpen = false"
        />
      </div>
    </template>
  </USlideover>

  <LazyDataViewExportSlideover
    v-if="exportOpened"
    v-model:open="exportOpen"
    :fields="fields"
    :ordered-fields="orderedFields"
    :rows="rows"
    :total="total"
    :cap="EXPORT_ALL_CAP"
    :warning-threshold="EXPORT_WARNING_THRESHOLD"
    :resource-name="resourceName"
    :display-format-defaults="displayFormatDefaults"
    :fetch-all="fetchAllMatchingRows"
    @exported="(count, format) => logBulkAuditEvent('EXPORT', count, format)"
  />

  <LazyDataViewPrintSlideover
    v-if="printOpened"
    v-model:open="printOpen"
    :fields="fields"
    :ordered-fields="orderedFields"
    :rows="rows"
    :total="total"
    :cap="PRINT_ALL_CAP"
    :warning-threshold="PRINT_WARNING_THRESHOLD"
    :display-format-defaults="displayFormatDefaults"
    :fetch-all="fetchAllMatchingRows"
    :title="dataviewTitle"
    :description="dataviewDescription"
    :filter-summary="printFilterSummary"
    @printed="(count) => logBulkAuditEvent('PRINT', count, 'pdf')"
  />

  <LazyDataViewImportSlideover
    v-if="importOpened"
    v-model:open="importOpen"
    :fields="fields"
    :primary-key="primaryKey"
    :schema="schema"
    :resource-name="resourceName"
    :warning-threshold="EXPORT_WARNING_THRESHOLD"
    @imported="onImported"
  />

  <!-- A record form made of widgets: the DataView's generated page. -->
  <LazyDataViewRecordPanel
    v-if="primaryKey && editPresentation !== 'PAGE' && formMounted && dataview"
    v-model:open="formOpen"
    :dataview="dataview"
    :fields="fields"
    :mode="formMode"
    :row="editingRow"
    :initial-values="createInitialValues"
    :primary-key="primaryKey"
    :presentation="editPresentation"
    :size="editSize"
    :side="editSide"
    :features="activeFeatures"
    :note="recordFormNote"
    :can-create="mayCreate"
    :can-delete="mayDelete"
    @saved="onSaved"
    @deleted="onDeleted"
    @changed="() => { void refresh(); emit('rowsChanged', { action: 'update', rows: [] }) }"
  />
  <DataViewBulkEditSlideover
    v-if="bulkEditOpen && primaryKey"
    v-model:open="bulkEditOpen"
    :dataview-id="dataviewId"
    :schema="schema"
    :table="resourceName"
    :primary-key="primaryKey"
    :fields="fields"
    :presentation="dataview?.columnPresentation?.[dataview?.sourceResource ?? ''] ?? undefined"
    :rows="selectedRows"
    @applied="() => { clearSelection(); void refresh(); emit('rowsChanged', { action: 'update', rows: [] }) }"
  />

  <RecordHistoryPanel
    v-if="sourceResourceId && primaryKey && tableHistoryOpened"
    v-model:open="tableHistoryOpen"
    :resource-id="sourceResourceId"
    :primary-key="primaryKey"
    :resource-label="dataviewTitle"
    :field-order="fields.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName!)"
    :field-labels="columnTitles(fields)"
    :dataview-slug="dataviewSlug"
  />
  <RecordHistoryPanel
    v-if="sourceResourceId && primaryKey && activityPk !== null"
    :open="true"
    :resource-id="sourceResourceId"
    :primary-key="primaryKey"
    :pk-value="activityPk"
    :resource-label="dataviewTitle"
    :field-order="fields.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName!)"
    :field-labels="columnTitles(fields)"
    @update:open="(open: boolean) => { if (!open) activityPk = null }"
  />

  <!-- One row's delete (its "⋮"), and the selected rows' (the page header's bulk Delete). -->
  <DataViewGridDeleteModal
    :open="dropTarget !== null"
    :title="t('dataviews.grid.deleteRowTitle')"
    :body="t('dataviews.grid.deleteRowBody')"
    :loading="dropping"
    @update:open="(v: boolean) => { if (!v) dropTarget = null }"
    @confirm="confirmDrop"
  />
  <DataViewGridDeleteModal
    v-model:open="selection.bulkDropConfirmOpen.value"
    :title="t('dataviews.grid.deleteRowsTitle')"
    :body="t('dataviews.grid.deleteRowsBody', { count: selectedCount })"
    :loading="selection.bulkDeleting.value"
    require-confirm
    @confirm="selection.confirmBulkDrop"
  />
</template>
