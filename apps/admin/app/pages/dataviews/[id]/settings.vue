<script setup lang="ts">
/**
 * Editing an existing DataView's own SETTINGS - identity, columns,
 * layout/filter, and features. Was a `USlideover` until this page
 * replaced it (this screen kept growing - Card/Map layout's BindingButton fields on top of
 * everything else already there - past what a sidebar comfortably
 * holds, the same "PAGE beats an overlay once a form is long" reasoning
 * `EditPresentation`'s own doc comment already applies to the RECORD
 * edit form). A fixed presentation, unlike that record form's own
 * DRAWER/MODAL/SIDEBAR/PAGE choice - this is a builder-only screen, no
 * viewer ever reaches it, so there's no reason to make its container
 * configurable too.
 *
 * SECTIONS (Specification_DataViews.md §3.6) - a horizontal navigation
 * under the header, as Nuxt UI's Settings template, each section its own
 * URL (`?section=`). They tell one story, a question each - which data, how
 * it shows, what it lets do, who uses it - and the wizard's steps follow the
 * same order; the type decides which it has:
 * - General: identity and presentation in the App.
 * - Data: Columns (with what a new column does at their foot) and Scope (the
 *   row Filter, the Query); a CUSTOM page's Record table instead.
 * - Views (a list type): the presentation every view shares, then a row per
 *   list view (DataViewViewsAccordion.vue) - offered, its place, the main one,
 *   its layout and its own controls.
 * - Form: how the record form opens and the record's actions.
 * - Actions: Allow, then the toolbar's buttons.
 * - Security: which roles open it - applied at once, not on publish.
 * - Page: EXTERNALFRAME's frame, a CUSTOM page's width.
 * - Layout: a SETTINGS DataView's columns.
 * A section mounts on its first visit and stays mounted. Position on the
 * FORM grid, per-field bindings and container placement stay the Design
 * form's own job, not duplicated here.
 *
 * The Design form (pages/dataviews/[id]/design.vue - canvas, palette,
 * inspector, bindings, code) is its own screen, reached from the
 * header's "Design" action, not a group of this page.
 *
 * SAVING is autosave everywhere (useAutosave.ts, same as the Dashboards
 * and Workflows editors - Publish is the one deliberate step): Columns
 * save each edit immediately (`saveFieldPatch`/`patchDefaultState`
 * below), and every OTHER group (General/Scope/
 * Card/Map/.../Features) as one PATCH (`saveSettings`) after a
 * short pause - skipped while the form has a "mid-edit" invalid state (an
 * empty slug, broken Filter JSON, a missing required Card/Map formula),
 * and resumed as soon as it's valid again. The header's "Design" action
 * flushes every pending save first, then navigates to the designer's
 * own page (the DataView's controller code is edited there, in its Code
 * tab).
 *
 * Source/columns/view_type themselves stay create-time-only for this
 * delivery step (Specification_DataViews.md's phased
 * plan) - changing the DATA SOURCE isn't offered here or in the Design
 * form.
 */
import {
  AUTO_REFRESH_PRESETS,
  DEFAULT_MAP_VIEW,
  resolveAutoRefresh,
  resolveBaseWhere,
  resolveCalendarLayout,
  resolveCardLayout,
  resolveColumnSync,
  resolveDefaultState,
  resolveEditPresentation,
  resolveEditSide,
  storedEditSize,
  resolveFeatures,
  resolveFitToScreen,
  resolveKiosk,
  resolveFormViewMode,
  resolveMasterDetailOpenWith,
  storedPageContentAlign,
  storedListMargin,
  resolveSettingsLayout,
  type SettingsLayoutConfig,
  storedPageContentWidth,
  resolveFrameUrl,
  resolveGanttLayout,
  resolveTreeLayout,
  resolveKanbanLayout,
  resolveMapLayout,
  resolveMapView,
  DATAVIEW_TYPE_META,
  type ColumnSync,
  type DataViewField,
  type DataView,
  type DataViewPublish,
  type DataViewVersionSnapshot,
  type EditPresentation,
  type EditSide,
  type EditSize,
  type FormViewMode,
  type MasterDetailOpenWith,
  type PageContentAlign,
  type PageContentWidth,
  type CalendarLayoutConfig,
  type CardLayoutConfig,
  type GanttLayoutConfig,
  type TreeLayoutConfig,
  type KanbanLayoutConfig,
  type MapLayoutConfig,
  type MapViewConfig,
  type UpdateDataViewBody,
  type DataViewType,
  LIST_DATAVIEW_TYPES,
  resolveListFeatures,
  resolveLayouts,
  mapLocationReady
} from '~/types/dataview'
import {
  emptyMapLayout,
  pickCalendarLayout,
  pickCardLayout,
  pickGanttLayout,
  pickTreeLayout,
  pickKanbanLayout,
  pickMapLayout,
  type WizardColumn
} from '~/utils/dataview-wizard-layouts'
import type { CatalogColumn, RoleColor } from '~/types/permission'
import type { CustomAction } from '@totalbase/tb-catalog'
import type { RelationDetail } from '~/types/schema'
import { embeddableFrameUrl } from '~/utils/frame-url'
import { checkConstraintValues, isDateDataType } from '@totalbase/tb-catalog'

const route = useRoute()
const router = useRouter()
const navigation = usePagePreferences('dataviews-navigation', { lastId: null as string | null })
navigation.lastId = route.params.id as string
const id = computed(() => route.params.id as string)
const { t } = useI18n()
const notifyError = useErrorToast()
const api = useAdminApi()
const toast = useToast()

const { dataview, fields, pending, fieldsPending, error, refreshDataview, refreshFields, primaryKey } = useDataViewById(id)

// --- General (identity) ---
const name = ref('')
const description = ref<string | null>(null)
/** What the App menu shows - empty: its name. Live like the name: it reaches the menu at once, no publish. */
const menuLabel = ref<string | null>(null)
const slugField = ref('')
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)
// Editing an existing row starts with slug already "touched" (see
// NameSlugFields' own doc comment) - a saved slug never gets silently
// rewritten just because the name changes here.
const slugTouched = ref(true)
/** The "Show in the App menu" switch (ShowInAppMenuField.vue) - LISTED or EMBEDDED_ONLY. */
const scope = ref<'LISTED' | 'EMBEDDED_ONLY'>('LISTED')

// --- General settings (view_config) - not shown directly in Group 1,
// populated/saved alongside it. ---
const editPresentation = ref<EditPresentation>('DRAWER')
const editSize = ref<EditSize | null>(null)
const editSide = ref<EditSide>('right')
/** FORM only - `view_config.form_view_mode`, what the form opens into (the wizard's own Mode for a FORM). */
const formViewMode = ref<FormViewMode>('READ')
/** MASTER_DETAIL only - `view_config.open_with` and its New button's `new_record_label` (types/dataview.ts). */
const masterDetailOpenWith = ref<MasterDetailOpenWith>('NEW_RECORD')
const newRecordLabel = ref('')
/** A record page's options (FORM, MASTER_DETAIL, a list's PAGE edit form) - `page_content_width`, `page_content_align`, `fit_to_screen`; a CUSTOM page's width and align. Null: the instance's. */
const pageContentWidth = ref<PageContentWidth | null>(null)
const pageContentAlign = ref<PageContentAlign | null>(null)
const fitToScreen = ref(false)
/** CUSTOM only - `view_config.kiosk`: the page alone on screen in the App (Specification_DataViews.md §7.3). */
const kiosk = ref(false)
const columnSync = ref<ColumnSync>('auto_hide')
/** `view_config.allow` - what its viewers may do besides reading, only less than their permissions (Specification_DataViews.md §5.1). */
const ALLOW_ACTIONS = ['create', 'update', 'delete'] as const
const allow = ref<string[]>([...ALLOW_ACTIONS])
/** `view_config.custom_actions` - its own actions on a row, the record or a selection (Specification_DataViews.md §3.7). */
const customActions = ref<CustomAction[]>([])
const featureFlags = ref<Record<string, boolean>>({})
/** One of AUTO_REFRESH_PRESETS' own values ('' = off, 'custom' = use autoRefreshCustom below, else a preset duration string used as-is). */
const autoRefreshPreset = ref('off')
/** Only meaningful when autoRefreshPreset === 'custom' - a raw Grafana-style duration string (parse-refresh-interval.ts), e.g. "45s" or "2h". */
const autoRefreshCustom = ref('')
/** Raw JSON text, not yet parsed - same "draft string, parsed only on save" convention as BindingButton's own boolean bindings. */
const baseWhereText = ref('')

const relationDetail = ref<RelationDetail | null>(null)
const catalogLoading = ref(false)
/** EXTERNALFRAME has no data source at all - only General and Security apply there; every other group needs a real table/view. */
const hasSource = computed(() => dataview.value?.sourceResourceOid !== null && dataview.value?.sourceResourceOid !== undefined)
/** EXTERNALFRAME's own group instead: `view_config.frame_url` plus its two features, with a live preview (DataViewFrameSettings.vue). */
const isFrame = computed(() => dataview.value?.viewType === 'EXTERNALFRAME')
/** A CUSTOM page's table is its record's, not a grid's - its Record group instead of Columns, Features and Scope. */
const isCustom = computed(() => dataview.value?.viewType === 'CUSTOM')
const hasGridSource = computed(() => hasSource.value && !isCustom.value)
const frameUrl = ref('')
const bindingColumns = computed<CatalogColumn[]>(() => relationDetail.value?.columns ?? [])

/**
 * `view_config.default_state` (types/dataview.ts's own `resolveDefaultState`)
 * - the DataView-wide fallback a first-time viewer (or anyone who never
 * personally customized anything) gets, instead of raw DB column order.
 * Declared here (not down in Group 6/Features, where the rest of its
 * read-only summary/Clear button still live) because the Columns
 * table's own default ORDER (`columnOrder` below) needs it too - one
 * ref, read by both groups, instead of two independent fetches of the
 * same `view_config` key drifting apart.
 */
const currentDefaultState = ref<Record<string, unknown>>({})

// --- Columns (DataViewColumnsSettings.vue): every COLUMN field, in real
// table order - the layouts and the form's readiness read them too.
const columnFields = computed(() => {
  const cols: (DataViewField & { columnAttnum: number })[] = []
  for (const f of fields.value ?? []) {
    if (f.kind === 'COLUMN' && f.columnAttnum !== null) cols.push(f as DataViewField & { columnAttnum: number })
  }
  return cols.sort((a, b) => a.columnAttnum - b.columnAttnum)
})
/** The Columns table's rows: the source's columns, then its related ones (`brand.country`) - what the grid reads. */
const gridColumnFields = computed<DataViewField[]>(() => [...columnFields.value, ...(fields.value ?? []).filter(f => f.kind === 'RELATED')])

/** A column added or removed: the fields and the publish status again. */
function refreshColumns() {
  return Promise.all([refreshFields(), refreshStatus()])
}

// --- Layout settings (CARDS/MAP/KANBAN/CALENDAR/GANTT) - one Lazy
// component each (DataView<Type>Settings.vue), bound to its typed config
// (types/dataview.ts). Resolved from BOTH `dataview` and `columnFields`:
// the resolvers validate stored columns against the DataView's columns,
// and `fields` is a separate fetch that can land after `dataview`.
// Populated once per DataView id - a later `fields` refetch (Sync
// columns) must not overwrite unsaved edits here.
const cardLayout = ref<CardLayoutConfig | null>(null)
const mapLayout = ref<MapLayoutConfig | null>(null)
const mapView = ref<MapViewConfig>({ ...DEFAULT_MAP_VIEW })
const kanbanLayout = ref<KanbanLayoutConfig | null>(null)
const calendarLayout = ref<CalendarLayoutConfig | null>(null)
const ganttLayout = ref<GanttLayoutConfig | null>(null)
const treeLayout = ref<TreeLayoutConfig | null>(null)
/** SETTINGS: which columns hold each setting (`view_config.settings_layout`). */
const settingsLayout = ref<SettingsLayoutConfig | null>(null)
/** A list DataView's views (`view_config.layouts`, Specification_DataViews.md §5.13) - each one's settings group shows while it's offered. */
const layouts = ref<DataViewType[]>([])
/** The main view - the one it opens with (`view_type`); any view it offers. */
const mainView = ref<DataViewType>('TABLE')
let layoutPopulatedFor: string | null = null
watch([dataview, columnFields], ([dv, cols]) => {
  if (!dv || layoutPopulatedFor === dv.id || cols.length === 0) return
  layoutPopulatedFor = dv.id
  const offered = resolveLayouts(dv)
  layouts.value = offered
  mainView.value = dv.viewType
  cardLayout.value = offered.includes('CARDS') ? resolveCardLayout(dv.viewConfig, cols) : null
  mapLayout.value = offered.includes('MAP') ? resolveMapLayout(dv.viewConfig, cols) : null
  if (offered.includes('MAP')) mapView.value = resolveMapView(dv.viewConfig)
  kanbanLayout.value = offered.includes('KANBAN') ? resolveKanbanLayout(dv.viewConfig, cols) : null
  calendarLayout.value = offered.includes('CALENDAR') ? resolveCalendarLayout(dv.viewConfig, cols) : null
  ganttLayout.value = offered.includes('GANTT') ? resolveGanttLayout(dv.viewConfig, cols) : null
  treeLayout.value = offered.includes('TREE') ? resolveTreeLayout(dv.viewConfig, cols) : null
  settingsLayout.value = dv.viewType === 'SETTINGS' ? resolveSettingsLayout(dv.viewConfig) : null
}, { immediate: true })

/** The source's columns as the wizard proposes layouts from them - what each view needs is read from these. */
/** The source's columns with a CHECK list - a Kanban's lanes, a value each. */
const checkListColumns = computed(() => {
  const expressions = (relationDetail.value?.checkConstraints ?? []).map(c => c.expression)
  return bindingColumns.value.map(c => c.name).filter(name => checkConstraintValues(name, expressions) !== null)
})
const layoutColumns = computed<WizardColumn[]>(() => {
  const foreignKeys = new Set((relationDetail.value?.relations ?? []).map(r => r.sourceColumn))
  return bindingColumns.value.map(c => ({ name: c.name, label: c.name, dataType: c.dataType, isForeignKey: foreignKeys.has(c.name), isCheckList: checkListColumns.value.includes(c.name), isSelfReference: selfReferences.value.includes(c.name) }))
})
/** The source's foreign keys to itself - a TREE's parent (Specification_DataViews.md §5.14). */
const selfReferences = computed(() => (relationDetail.value?.relations ?? [])
  .filter(r => r.targetSchema === dataview.value?.sourceResourceSchema && r.targetTable === dataview.value?.sourceResourceName)
  .map(r => r.sourceColumn))
/** Which views the source can show: a calendar needs a date, a Gantt two, a map a location, a Kanban a foreign key to group by. */
const availableLayouts = computed<Partial<Record<DataViewType, boolean>>>(() => {
  const cols = layoutColumns.value
  return {
    TABLE: true,
    CARDS: true,
    MAP: mapLocationReady(pickMapLayout(emptyMapLayout(), cols)),
    KANBAN: cols.some(c => c.isForeignKey || c.isCheckList),
    CALENDAR: cols.some(c => isDateDataType(c.dataType)),
    GANTT: cols.filter(c => isDateDataType(c.dataType)).length >= 2,
    TREE: cols.some(c => c.isSelfReference)
  }
})
/** A view turned on gets its settings - what it had stored, completed from the columns; turned off, they leave the form (the stored ones stay for next time). */
watch(layouts, (offered) => {
  const dv = dataview.value
  if (!dv || layoutPopulatedFor !== dv.id) return
  const cols = columnFields.value
  const wizard = layoutColumns.value
  if (!offered.includes('CARDS')) cardLayout.value = null
  else cardLayout.value ??= pickCardLayout(resolveCardLayout(dv.viewConfig, cols), wizard)
  if (!offered.includes('MAP')) mapLayout.value = null
  else if (!mapLayout.value) {
    mapLayout.value = pickMapLayout(resolveMapLayout(dv.viewConfig, cols), wizard)
    mapView.value = resolveMapView(dv.viewConfig)
  }
  if (!offered.includes('KANBAN')) kanbanLayout.value = null
  else kanbanLayout.value ??= pickKanbanLayout(resolveKanbanLayout(dv.viewConfig, cols), wizard)
  if (!offered.includes('CALENDAR')) calendarLayout.value = null
  else calendarLayout.value ??= pickCalendarLayout(resolveCalendarLayout(dv.viewConfig, cols), wizard)
  if (!offered.includes('GANTT')) ganttLayout.value = null
  else ganttLayout.value ??= pickGanttLayout(resolveGanttLayout(dv.viewConfig, cols), wizard)
  if (!offered.includes('TREE')) treeLayout.value = null
  else treeLayout.value ??= pickTreeLayout(resolveTreeLayout(dv.viewConfig, cols), wizard)
})

// --- Group 6: Features ---
/**
 * `view_config.default_state` (types/dataview.ts's own doc comment) -
 * the DataView-wide fallback a first-time viewer (or anyone who never
 * personally customized anything) gets. Density/page size are the two
 * pieces this page lets a builder set DIRECTLY here (real selects, not
 * just a read-only summary of whatever the live grid's own "Set as
 * default for everyone" last captured, the way this used to work) -
 * `userPrefsConfig`'s own doc comment in `DataViewGrid.vue` is why this
 * needs no runtime change at all: `default_state` and a viewer's own
 * personal saved prefs already share the exact same shape, so writing
 * `density`/`pageSize` here is read back through the identical fallback
 * chain (personal pref -> `default_state` -> the runtime's own
 * hardcoded default) `sort` already went through. `` (empty string) /
 * `0` are this page's own "not set, use the runtime default" sentinels
 * - never written, just omitted from what's saved (see `saveSettings`).
 * Columns/ORDER and SORT are the other two pieces, set as per-row
 * controls in the Columns table above instead (`columnOrder`/
 * `sortEntries`) - one place per concept, not split across groups.
 */
const defaultDensity = ref('')
let originalDensity = ''
const defaultToolbarMode = ref('')
/** A list's margin (`view_config.list_margin`) - '' is Default, the instance's. */
const listMargin = ref('')
let originalToolbarMode = ''
const defaultPageSize = ref(0)
let originalPageSize = 0

const relationDetailFetchedFor = ref<number | null>(null)

watch(dataview, async (dv) => {
  if (!dv) return
  // A refetch (rollback, Design form save) repopulates the form - that's
  // the new baseline, not an edit.
  nextTick(takeSettingsBaseline)
  name.value = dv.name
  description.value = dv.description
  menuLabel.value = dv.menuLabel ?? null
  slugField.value = dv.slug
  icon.value = dv.icon ?? undefined
  color.value = dv.color ?? undefined
  scope.value = dv.scope
  slugTouched.value = true

  editPresentation.value = resolveEditPresentation(dv.viewConfig)
  editSize.value = storedEditSize(dv.viewConfig)
  editSide.value = resolveEditSide(dv.viewConfig)
  formViewMode.value = resolveFormViewMode(dv.viewConfig)
  masterDetailOpenWith.value = resolveMasterDetailOpenWith(dv.viewConfig)
  newRecordLabel.value = typeof dv.viewConfig.new_record_label === 'string' ? dv.viewConfig.new_record_label : ''
  pageContentWidth.value = storedPageContentWidth(dv.viewConfig)
  pageContentAlign.value = storedPageContentAlign(dv.viewConfig)
  fitToScreen.value = resolveFitToScreen(dv.viewConfig)
  kiosk.value = resolveKiosk(dv.viewConfig)
  columnSync.value = resolveColumnSync(dv.viewConfig)
  customActions.value = Array.isArray(dv.viewConfig.custom_actions) ? structuredClone(toRaw(dv.viewConfig.custom_actions as CustomAction[])) : []
  allow.value = Array.isArray(dv.viewConfig.allow) ? (dv.viewConfig.allow as string[]).filter(a => (ALLOW_ACTIONS as readonly string[]).includes(a)) : [...ALLOW_ACTIONS]
  // A list DataView may switch to any of its views: every list view's features.
  featureFlags.value = LIST_DATAVIEW_TYPES.includes(dv.viewType) ? resolveListFeatures(dv.viewConfig) : resolveFeatures(dv.viewType, dv.viewConfig)
  frameUrl.value = resolveFrameUrl(dv.viewConfig)
  const autoRefresh = resolveAutoRefresh(dv.viewConfig)
  const preset = autoRefresh ? AUTO_REFRESH_PRESETS.find(p => p.value === autoRefresh) : undefined
  autoRefreshPreset.value = autoRefresh ? (preset ? preset.value : 'custom') : 'off'
  autoRefreshCustom.value = autoRefresh && !preset ? autoRefresh : ''
  const baseWhere = resolveBaseWhere(dv.viewConfig)
  baseWhereText.value = baseWhere ? JSON.stringify(baseWhere, null, 2) : ''
  currentDefaultState.value = resolveDefaultState(dv.viewConfig)
  const storedDensity = currentDefaultState.value.density
  defaultDensity.value = typeof storedDensity === 'string' ? storedDensity : ''
  originalDensity = defaultDensity.value
  const storedToolbarMode = currentDefaultState.value.toolbarMode
  defaultToolbarMode.value = storedToolbarMode === 'full' || storedToolbarMode === 'compact' ? storedToolbarMode : ''
  listMargin.value = storedListMargin(dv.viewConfig) ?? ''
  originalToolbarMode = defaultToolbarMode.value
  const storedPageSize = currentDefaultState.value.pageSize
  defaultPageSize.value = typeof storedPageSize === 'number' ? storedPageSize : 0
  originalPageSize = defaultPageSize.value
  if (dv.sourceResourceOid !== null && relationDetailFetchedFor.value !== dv.sourceResourceOid) {
    catalogLoading.value = true
    try {
      const { data } = await api.get<RelationDetail>(`/catalog/${dv.sourceResourceType === 'VIEW' ? 'view' : 'table'}/${dv.sourceResourceOid}`)
      relationDetail.value = data
      relationDetailFetchedFor.value = dv.sourceResourceOid
    } catch {
      // Non-fatal - Filter's Builder popover just stays unavailable, the rest of the page still works.
    } finally {
      catalogLoading.value = false
    }
  }
}, { immediate: true })

// Description is NOT required here (unlike the wizard's own Identity
// step): a DataView being edited already has a
// real name/slug people rely on, making description mandatory too just
// to save an unrelated column-visibility tweak is friction with nothing
// behind it.
/** A view whose layout still misses a required piece - its tab says so. */
const viewInvalid = computed<Partial<Record<DataViewType, boolean>>>(() => ({
  CARDS: !!cardLayout.value && !cardLayout.value.titleFormula,
  MAP: !!mapLayout.value && !(mapLocationReady(mapLayout.value) && mapLayout.value.nameFormula),
  KANBAN: !!kanbanLayout.value && !kanbanLayout.value.groupColumn,
  CALENDAR: !!calendarLayout.value && !(calendarLayout.value.dateColumn && calendarLayout.value.titleFormula),
  GANTT: !!ganttLayout.value && !(ganttLayout.value.startDateColumn && ganttLayout.value.endDateColumn && ganttLayout.value.titleFormula),
  TREE: !!treeLayout.value && !(treeLayout.value.parentColumn && treeLayout.value.titleFormula)
}))
const valid = computed(() =>
  name.value.trim().length > 0 && slugField.value.trim().length > 0
  && (!isFrame.value || embeddableFrameUrl(frameUrl.value) !== null)
  && !Object.values(viewInvalid.value).some(Boolean)
)
const baseWhereError = computed(() => {
  const text = baseWhereText.value.trim()
  if (!text) return false
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
})

// --- Sections (`?section=`) and, in Views, the view tabs (`?view=`) - see this file's doc comment.
type SectionKey = 'general' | 'data' | 'views' | 'form' | 'actions' | 'security' | 'versions' | 'page' | 'layout'
const SECTION_ICONS: Record<SectionKey, string> = {
  general: 'i-lucide-settings-2',
  data: 'i-lucide-database',
  views: 'i-lucide-layout-grid',
  form: 'i-lucide-square-pen',
  actions: 'i-lucide-mouse-pointer-click',
  security: 'i-lucide-shield',
  versions: 'i-lucide-git-commit-vertical',
  page: 'i-lucide-app-window',
  layout: 'i-lucide-sliders-horizontal'
}
const isList = computed(() => !!dataview.value && LIST_DATAVIEW_TYPES.includes(dataview.value.viewType))
const sectionKeys = computed<SectionKey[]>(() => {
  const type = dataview.value?.viewType
  if (!type) return ['general']
  if (type === 'EXTERNALFRAME') return ['general', 'page', 'security', 'versions']
  if (type === 'CUSTOM') return ['general', 'data', 'page', 'security', 'versions']
  if (type === 'SETTINGS') return ['general', 'data', 'layout', 'actions', 'security', 'versions']
  return isList.value ? ['general', 'data', 'views', 'form', 'actions', 'security', 'versions'] : ['general', 'data', 'form', 'actions', 'security', 'versions']
})
const section = computed<SectionKey>(() => {
  const asked = route.query.section as SectionKey
  return sectionKeys.value.includes(asked) ? asked : 'general'
})
/** What still needs completing, per section - autosave waits for it; the navigation points at it. */
const sectionInvalid = computed<Partial<Record<SectionKey, boolean>>>(() => ({
  general: !name.value.trim() || !slugField.value.trim(),
  data: baseWhereError.value,
  views: Object.values(viewInvalid.value).some(Boolean),
  page: isFrame.value && embeddableFrameUrl(frameUrl.value) === null
}))
const sectionItems = computed(() => sectionKeys.value.map(key => ({
  label: t(`designer.settingsPage.sections.${key}`),
  icon: SECTION_ICONS[key],
  to: { query: { section: key } },
  active: section.value === key,
  ...(sectionInvalid.value[key] && { badge: { 'icon': 'i-lucide-circle-alert', 'color': 'error' as const, 'variant': 'subtle' as const, 'aria-label': t('designer.settingsPage.sections.invalid') } })
})))
// A section mounts on its first visit and stays mounted - switching back keeps its state.
const visitedSections = ref(new Set<SectionKey>())
watch(section, key => visitedSections.value.add(key), { immediate: true })
/** A table or cards among its views - the density and page size a first-time viewer starts with apply. */
const pagedViews = computed(() => layouts.value.includes('TABLE') || layouts.value.includes('CARDS') || mainView.value === 'TABLE' || mainView.value === 'CARDS')
/** Allow's own section - a role's "taken by Allow" in Security links there. */
const allowLink = computed(() => router.resolve({ query: { section: 'actions' }, hash: '#allow' }).href)

/**
 * Identity + view settings as one PATCH body - autosaved (useAutosave.ts)
 * whenever it changes, like every other edit on this page; Publish is the
 * one deliberate step. Columns (visible/label/widget/help/required/
 * disabled/order/sort) and Code aren't part of it: they autosave per edit
 * (`saveFieldPatch`/`patchDefaultState`/the Code watcher).
 */
function buildSettingsBody(): UpdateDataViewBody {
  if (isFrame.value) {
    return {
      name: name.value,
      slug: slugField.value,
      description: description.value,
      menuLabel: menuLabel.value,
      icon: icon.value ?? null,
      color: color.value ?? null,
      scope: scope.value,
      viewConfig: { frame_url: frameUrl.value.trim(), features: featureFlags.value }
    }
  }
  const autoRefreshValue = autoRefreshPreset.value === 'custom'
    ? (autoRefreshCustom.value.trim() || null)
    : (autoRefreshPreset.value === 'off' ? null : autoRefreshPreset.value)
  const viewConfig: Record<string, unknown> = {
    edit_presentation: editPresentation.value,
    edit_size: editSize.value,
    edit_side: editSide.value,
    column_sync: columnSync.value,
    features: featureFlags.value,
    auto_refresh: autoRefreshValue,
    page_content_width: pageContentWidth.value,
    list_margin: listMargin.value || null,
    page_content_align: pageContentAlign.value
  }
  if (!isCustom.value) viewConfig.fit_to_screen = fitToScreen.value
  // Off is the default: null drops the key.
  if (isCustom.value) viewConfig.kiosk = kiosk.value || null
  if (dataview.value?.viewType === 'FORM') viewConfig.form_view_mode = formViewMode.value
  if (dataview.value?.viewType === 'MASTER_DETAIL') {
    viewConfig.open_with = masterDetailOpenWith.value
    viewConfig.new_record_label = newRecordLabel.value.trim() || null
  }
  if (hasGridSource.value) viewConfig.allow = allow.value.length === ALLOW_ACTIONS.length ? null : allow.value
  if (hasGridSource.value) viewConfig.custom_actions = customActions.value.length ? customActions.value : null
  if (hasGridSource.value) {
    const text = baseWhereText.value.trim()
    viewConfig.base_where = text && !baseWhereError.value ? JSON.parse(text) : {}
  }
  if (dataview.value && LIST_DATAVIEW_TYPES.includes(dataview.value.viewType)) viewConfig.layouts = layouts.value.length > 1 ? layouts.value : null
  if (cardLayout.value) viewConfig.card_layout = cardLayout.value
  if (mapLayout.value) {
    viewConfig.map_layout = mapLayout.value
    viewConfig.map_view = mapView.value
  }
  if (kanbanLayout.value) viewConfig.kanban_layout = kanbanLayout.value
  if (calendarLayout.value) viewConfig.calendar_layout = calendarLayout.value
  if (ganttLayout.value) viewConfig.gantt_layout = ganttLayout.value
  if (treeLayout.value) viewConfig.tree_layout = treeLayout.value
  if (settingsLayout.value) viewConfig.settings_layout = settingsLayout.value
  // `default_state` merges shallowly at the TOP LEVEL only (view_config
  // itself, server-side) - replacing it wholesale would silently wipe
  // whatever piece of it this save doesn't touch (order/sort included -
  // both autosaved straight from the Columns table now, through
  // `patchDefaultState`, not this settings PATCH at all), so density/
  // pageSize spread the CURRENTLY stored object first.
  const densityChanged = defaultDensity.value !== originalDensity
  const pageSizeChanged = defaultPageSize.value !== originalPageSize
  const toolbarModeChanged = defaultToolbarMode.value !== originalToolbarMode
  if (densityChanged || pageSizeChanged || toolbarModeChanged) {
    const next: Record<string, unknown> = { ...currentDefaultState.value }
    if (densityChanged) {
      if (defaultDensity.value) next.density = defaultDensity.value
      else delete next.density
    }
    if (toolbarModeChanged) {
      if (defaultToolbarMode.value) next.toolbarMode = defaultToolbarMode.value
      else delete next.toolbarMode
    }
    if (pageSizeChanged) {
      if (defaultPageSize.value) next.pageSize = defaultPageSize.value
      else delete next.pageSize
    }
    viewConfig.default_state = next
  }
  const body: UpdateDataViewBody = {
    name: name.value,
    slug: slugField.value,
    description: description.value,
    menuLabel: menuLabel.value,
    icon: icon.value ?? null,
    color: color.value ?? null,
    scope: scope.value,
    viewConfig
  }
  if (isList.value) body.viewType = mainView.value
  return body
}

/**
 * The body as last saved (or as loaded) - null until the form is fully
 * populated, so loading a DataView never reads as an edit. Reset whenever
 * `dataview` is refetched (rollback, Design form save).
 */
let settingsBaseline: string | null = null
const formReady = computed(() => !!dataview.value && !pending.value && !fieldsPending.value && (!hasGridSource.value || columnFields.value.length > 0))

/**
 * What a save sends: identity as it is (not versioned - Specification.md §13.1),
 * but of `view_config` only the keys changed since the baseline. The
 * form holds every setting at its resolved default; sending them all would
 * write defaults the stored config leaves implicit - and read as
 * "Unpublished changes" after a mere rename.
 */
function changedSettings(body: UpdateDataViewBody): UpdateDataViewBody {
  const before = settingsBaseline ? (JSON.parse(settingsBaseline) as UpdateDataViewBody).viewConfig ?? {} : null
  if (!before || !body.viewConfig) return body
  const changed = Object.fromEntries(Object.entries(body.viewConfig).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])))
  const { viewConfig: _all, ...identity } = body
  return Object.keys(changed).length ? { ...identity, viewConfig: changed } : identity
}

async function saveSettings() {
  if (!dataview.value || !valid.value || baseWhereError.value) return
  const body = buildSettingsBody()
  const json = JSON.stringify(body)
  if (json === settingsBaseline) return
  let saved: DataView
  try {
    saved = (await api.patch<DataView>(`/dataviews/${dataview.value.id}`, { data: changedSettings(body) })).data
  } catch (err) {
    notifyError(err, t('designer.settingsPage.saveError'))
    throw err
  }
  const identityChanged = !settingsBaseline || ['name', 'slug', 'icon', 'color', 'description', 'scope'].some(key =>
    (JSON.parse(settingsBaseline!) as Record<string, unknown>)[key] !== (body as Record<string, unknown>)[key])
  settingsBaseline = json
  // What `dataview` would say after a refetch - updated locally instead,
  // since refetching repopulates (and would clobber) the whole form.
  const savedDefaultState = (body.viewConfig as Record<string, unknown> | undefined)?.default_state
  if (savedDefaultState) {
    currentDefaultState.value = savedDefaultState as Record<string, unknown>
    originalDensity = defaultDensity.value
    originalToolbarMode = defaultToolbarMode.value
    originalPageSize = defaultPageSize.value
    // The next body no longer carries default_state - that isn't an edit. The baseline is what was sent, without it:
    // never the form as it is now, which may hold an edit made while this save was in flight (it must still go).
    const { default_state: _sent, ...sentViewConfig } = body.viewConfig as Record<string, unknown>
    settingsBaseline = JSON.stringify({ ...body, viewConfig: sentViewConfig })
  }
  // The response carries the status (live version, unpublished changes) - no second read per save.
  status.value = { liveVersion: saved.liveVersion ?? null, hasUnpublishedChanges: saved.hasUnpublishedChanges ?? true }
  if (identityChanged) useAppsNavDataViews().refresh()
}
const autosave = useAutosave(saveSettings)
function takeSettingsBaseline() {
  settingsBaseline = formReady.value ? JSON.stringify(buildSettingsBody()) : null
}
// Registered after the populate watchers above, so it sees the form filled in.
watch(formReady, takeSettingsBaseline, { immediate: true })
watch(() => JSON.stringify(buildSettingsBody()), (json) => {
  if (settingsBaseline === null) {
    takeSettingsBaseline()
    return
  }
  if (json !== settingsBaseline) autosave.schedule()
})

// --- The header's "Design" action - into the Design form, its own page
// (pages/dataviews/[id]/design.vue - still its own canvas/palette/
// inspector screen, this page never absorbs it, see this file's own doc
// comment). Every settings save still debouncing is flushed first, so the
// designer loads the server's current state - view_config's column_sync
// included (it gates the designer's palette, and its "Sync fields" reads
// it server-side). The Columns table's own field saves are already
// immediate (`saveFieldPatch`), and tracked by the same flush.
async function openDesignForm() {
  try {
    await autosave.flush()
  } catch {
    // The failed save already toasted - stay, so the unsaved edit isn't lost.
    return
  }
  await router.push(`/dataviews/${id.value}/design`)
}

// --- Versioning (Specification.md §13) - same header as the
// Dashboards and Workflows editors: versions chip, Publish, and a read-only
// preview of any version with Rollback / Save as / Back to draft. This page
// autosaves most edits into the draft, so the status (live version,
// "unpublished changes") is re-read after each save - on its own request,
// since refetching `dataview` itself would reset the form above.
const { data: status, refresh: refreshStatus } = useAsyncData(
  () => `dataview-status-${id.value}`,
  () => api.get<DataView>(`/dataviews/${id.value}`).then(r => ({ liveVersion: r.data.liveVersion ?? null, hasUnpublishedChanges: r.data.hasUnpublishedChanges ?? true })),
  { watch: [id] }
)
const { data: versions, refresh: refreshVersions } = useAsyncData(
  () => `dataview-versions-${id.value}`,
  () => api.get<DataViewPublish[]>(`/dataviews/${id.value}/versions`).then(r => r.data),
  { watch: [id], default: (): DataViewPublish[] => [] }
)
const liveVersion = computed(() => status.value?.liveVersion ?? null)
const hasUnpublishedChanges = computed(() => status.value?.hasUnpublishedChanges ?? false)
// The DataViews sidebar colors each entry by this same status.
watch(status, (value) => {
  if (value) useAppsNavDataViews().patchStatus(id.value, value)
})

const publishing = ref(false)
/** The one publish path of this page - the header's Publish and the Preview drawer's both run it. True once published. */
async function publish(note?: string): Promise<boolean> {
  if (!dataview.value) return false
  publishing.value = true
  try {
    await autosave.flush()
    const { data, meta } = await api.post<DataViewPublish>(`/dataviews/${dataview.value.id}/publish`, note ? { data: { note } } : undefined)
    await Promise.all([refreshStatus(), refreshVersions(), useAppsNavDataViews().refresh()])
    toast.add({ title: t('designer.settingsPage.published', { version: data.version }), color: 'success' })
    // Published anyway, worth a look - a single-record form over a table with more than one row.
    for (const warning of (meta?.warnings as string[] | undefined) ?? []) toast.add({ title: t('designer.publishWarning'), description: warning, color: 'warning' })
    return true
  } catch (err) {
    notifyError(err, t('designer.settingsPage.publishError'))
    return false
  } finally {
    publishing.value = false
  }
}

// --- Preview: the whole DataView from the current draft, with live data,
// read-only (DataViewPreviewDrawer.vue) - pending saves flushed first so it
// shows what's really in the draft. Publishing from there closes it.
const draftPreviewOpen = ref(false)
const draftPreviewMounted = useOpenedOnce(draftPreviewOpen)
async function openDraftPreview() {
  try {
    await autosave.flush()
  } catch {
    return // the failed save already toasted
  }
  draftPreviewOpen.value = true
}
async function publishFromPreview() {
  if (await publish()) draftPreviewOpen.value = false
}
/** EXTERNALFRAME has nothing to design - a source's columns or CUSTOM's widgets are what the Design form lays out. */
// A SETTINGS DataView has no form to design: its rows are edited in place.
const canDesign = computed(() => (hasSource.value && dataview.value?.viewType !== 'SETTINGS') || dataview.value?.viewType === 'CUSTOM')
const headerActions = computed<HeaderAction[]>(() => previewVersion.value
  ? []
  : [
      { label: t('common.preview'), icon: 'i-lucide-eye', tooltip: t('designer.settingsPage.previewTooltip'), onSelect: () => { void openDraftPreview() } },
      // See as (Specification_Security.md §8.4): the published DataView as a user or a role sees it.
      ...(liveVersion.value !== null ? [{ label: t('shell.viewAs.title'), icon: 'i-lucide-user-round-search', onSelect: () => { viewAsOpen.value = true } }] : [])
    ])
const viewAsOpen = ref(false)

const previewVersion = ref<DataViewVersionSnapshot | null>(null)
const previewLoading = ref(false)
async function selectVersion(version: number | null) {
  if (version === null || !dataview.value) {
    previewVersion.value = null
    return
  }
  previewLoading.value = true
  try {
    const { data } = await api.get<DataViewVersionSnapshot>(`/dataviews/${dataview.value.id}/versions/${version}`)
    previewVersion.value = data
  } catch (err) {
    notifyError(err, t('designer.settingsPage.loadVersionError'))
  } finally {
    previewLoading.value = false
  }
}

// Restore (Specification.md §13.4): that version replaces the draft - nothing is published.
// VersionPreviewBanner confirms first when there are unpublished changes,
// which this replaces. A pending autosave is flushed first, so it can't
// land on top of the restored draft afterwards.
const restoring = ref(false)
async function restore() {
  if (!previewVersion.value || !dataview.value) return
  const version = previewVersion.value.version
  restoring.value = true
  try {
    await autosave.flush()
    await api.post(`/dataviews/${dataview.value.id}/versions/${version}/restore`)
    previewVersion.value = null
    await Promise.all([refreshDataview(), refreshFields(), refreshStatus(), refreshVersions()])
    toast.add({ title: t('designer.settingsPage.restored', { version }), description: t('designer.settingsPage.restoredDescription'), color: 'success' })
  } catch (err) {
    notifyError(err, t('designer.settingsPage.restoreError'))
  } finally {
    restoring.value = false
  }
}

/** After Settings › Versions restored one: the draft, its fields, the status and the history re-read. */
async function onRestored() {
  await Promise.all([refreshDataview(), refreshFields(), refreshStatus(), refreshVersions()])
}

// Save as (Specification.md §13.4): a new, unpublished DataView from that version.
const saveAsOpen = ref(false)
const savingAs = ref(false)
async function saveAs(input: { name: string, slug: string }) {
  if (!previewVersion.value || !dataview.value) return
  savingAs.value = true
  try {
    const { data } = await api.post<DataView>(`/dataviews/${dataview.value.id}/versions/${previewVersion.value.version}/duplicate`, { data: input })
    saveAsOpen.value = false
    await useAppsNavDataViews().refresh()
    toast.add({ title: t('designer.settingsPage.created', { name: data.name }), description: t('designer.settingsPage.createdDescription'), color: 'success' })
    await navigateTo(`/dataviews/${data.id}/settings`)
  } catch (err) {
    notifyError(err, t('designer.settingsPage.copyError'))
  } finally {
    savingAs.value = false
  }
}

// Object actions - the "⋯" menu next to the title (same header layout as
// the Dashboards and Workflows editors).
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
const objectMenuItems = computed(() => [
  [{
    label: t('designer.settingsPage.openDataView'),
    icon: 'i-lucide-external-link',
    disabled: liveVersion.value === null,
    onSelect: () => { if (dataview.value) navigateTo(`/app/dataviews/${dataview.value.slug}`) }
  }],
  [{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]
])
// On a phone the versions chip moves into PageHeader's "⋮".
const { mobileMenu: versionsMobileMenu } = useVersionMenu(() => versions.value ?? [], () => previewVersion.value?.version ?? null, selectVersion, openDeleteVersions)
// "Delete old versions…" (Specification.md §13.4): a preview of a deleted version goes back to the draft.
const deleteVersionsOpen = ref(false)
function openDeleteVersions() {
  deleteVersionsOpen.value = true
}
async function onVersionsDeleted(deleted: number[]) {
  const viewing = previewVersion.value?.version
  if (viewing !== undefined && deleted.includes(viewing)) await selectVersion(null)
  await refreshVersions()
}
async function deleteDataview() {
  if (!dataview.value) return
  deleting.value = true
  try {
    await api.del(`/dataviews/${dataview.value.id}`)
    deleteOpen.value = false
    await useAppsNavDataViews().refresh()
    await navigateTo('/dataviews')
  } catch (err) {
    notifyError(err, t('designer.settingsPage.deleteError'))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <PageShell :scroll="false">
    <template
      v-if="!error"
      #header
    >
      <PageHeader
        :title="name || dataview?.name || ''"
        :description="(dataview ? description : undefined) ?? undefined"
        :icon="dataview ? DATAVIEW_TYPE_META[dataview.viewType].icon : 'i-lucide-panels-top-left'"
        height="editor"
        :menu="previewVersion ? undefined : objectMenuItems"
        :actions="headerActions"
        :mobile-menu="versionsMobileMenu"
      >
        <template #status>
          <SaveStatus
            v-if="!previewVersion"
            :status="autosave.status.value"
            @retry="autosave.retry()"
          />
        </template>
        <!-- The other screen (Specification_Admin_UI.md §3.7): what it designs - a record's form, or a CUSTOM DataView's whole page. -->
        <UButton
          v-if="canDesign && !previewVersion"
          icon="i-lucide-layout-dashboard"
          :label="dataview?.viewType === 'CUSTOM' ? t('designer.settingsPage.pageDesign') : t('designer.settingsPage.formDesign')"
          color="neutral"
          variant="outline"
          @click="openDesignForm"
        />
        <UnpublishedChangesBadge
          v-if="hasUnpublishedChanges && !previewVersion"
        />
        <VersionsMenu
          :versions="versions ?? []"
          :viewing="previewVersion?.version ?? null"
          @select="selectVersion"
          @delete-old="deleteVersionsOpen = true"
        />
        <DiagnosisBadge
          v-if="dataview && !previewVersion"
          :key="`diagnosis-${(liveVersion ?? 0)}`"
          kind="dataview"
          :object-id="id"
        />
        <PublishButton
          v-if="!previewVersion"
          :diagnosis="{ kind: 'dataview', objectId: id }"
          :loading="publishing"
          :disabled="!hasUnpublishedChanges"
          :next-version="(liveVersion ?? 0) + 1"
          :note="t('designer.settingsPage.publishNote')"
          @publish="publish"
        />
      </PageHeader>
      <ViewAsModal
        v-if="dataview && liveVersion !== null"
        v-model:open="viewAsOpen"
        :path="`/app/dataviews/${dataview.slug}`"
      />
    </template>
    <!-- The sections, as Nuxt UI's Settings template - each its own URL. -->
    <template
      v-if="!error && dataview && !previewVersion && !pending"
      #toolbar
    >
      <UNavigationMenu
        :items="sectionItems"
        orientation="horizontal"
        highlight
        :aria-label="t('designer.settingsPage.sections.nav')"
        :ui="{ item: 'shrink-0' }"
        class="overflow-x-auto"
      />
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <template v-else>
      <!-- Same header layout as the Dashboards and Workflows editors:
      object actions in the "⋯" menu next to the title; on the right,
      Save | publishing (Unpublished badge, versions, Publish last). -->
      <VersionPreviewBanner
        v-if="previewVersion"
        :version="previewVersion.version"
        :published-at="previewVersion.publishedAt"
        :is-live="previewVersion.version === liveVersion"
        :has-unpublished-changes="hasUnpublishedChanges"
        :restoring="restoring"
        @restore="restore"
        @save-as="saveAsOpen = true"
        @back="selectVersion(null)"
      />

      <div
        v-if="previewVersion"
        class="flex min-h-0 flex-1 flex-col"
      >
        <DataViewVersionPreview
          :dataview="previewVersion.dataview"
          :fields="previewVersion.fields"
          :render-key="previewVersion.version"
        />
      </div>

      <UEmpty
        v-else-if="pending || fieldsPending"
        loading
        variant="naked"
        size="sm"
      />

      <!-- A phone: the scroll container reaches the screen's edge (-mr-4
      pr-4 over PageShell's padding), so its scrollbar doesn't sit on the
      content. -->
      <div
        v-else
        class="flex flex-1 min-h-0 flex-col overflow-y-auto max-md:-mr-4 max-md:pr-4"
      >
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12">
          <!-- General: what every DataView type has - its identity and how the App presents it. -->
          <div
            v-if="visitedSections.has('general')"
            v-show="section === 'general'"
            class="flex flex-col gap-8"
          >
            <SettingsSection :title="t('designer.settingsPage.general')">
              <NameSlugFields
                v-model:name="name"
                v-model:slug="slugField"
                v-model:slug-touched="slugTouched"
                :slug-locked="dataview?.liveVersion != null"
                hide-description
              />
            </SettingsSection>

            <!-- Presentation in the App: whether the menu lists it, its label there, and what shows with it - in the menu,
            on its page's header and in the admin's lists (Specification_Security.md §8). -->
            <SettingsSection :title="t('shell.appPresentation.heading')">
              <AppPresentationFields
                v-model:scope="scope"
                v-model:menu-label="menuLabel"
                v-model:description="description"
                v-model:icon="icon"
                v-model:color="color"
                kind="DataView"
              />
            </SettingsSection>
          </div>

          <!-- Data: what the DataView reads - its columns, what a new column does, its rows; a CUSTOM page's record table. -->
          <div
            v-if="visitedSections.has('data')"
            v-show="section === 'data'"
            class="flex flex-col gap-8"
          >
            <DataViewRecordTableSettings
              v-if="dataview && isCustom"
              :dataview="dataview"
              @changed="refreshDataview()"
            />
            <template v-if="hasGridSource && dataview">
              <!-- Columns: what this DataView reads and how its grid shows it (Specification_DataViews.md §4). -->
              <DataViewColumnsSettings
                v-model:default-state="currentDefaultState"
                :dataview="dataview"
                :column-fields="gridColumnFields"
                :relation-detail="relationDetail"
                :primary-key="primaryKey"
                :track="autosave.track"
                :refresh="refreshColumns"
                :refresh-status="refreshStatus"
              />
              <DataViewColumnSyncField v-model="columnSync" />
              <!-- Scope: the row Filter and the resulting Query. -->
              <DataViewScopeSettings
                v-model:where-text="baseWhereText"
                :dataview="dataview"
                :name="name"
                :catalog-columns="catalogLoading ? undefined : bindingColumns"
                :column-fields="gridColumnFields"
                :primary-key="primaryKey"
                :default-state="currentDefaultState"
                :where-error="baseWhereError"
              />
            </template>
          </div>

          <!-- Views (a list type): what every view shares, then a row per list view (Specification_DataViews.md §5.13). -->
          <div
            v-if="visitedSections.has('views') && dataview && isList"
            v-show="section === 'views'"
            class="flex flex-col gap-8"
          >
            <DataViewPresentationSettings
              v-model:default-density="defaultDensity"
              v-model:default-page-size="defaultPageSize"
              v-model:default-toolbar-mode="defaultToolbarMode"
              v-model:list-margin="listMargin"
              v-model:auto-refresh-preset="autoRefreshPreset"
              v-model:auto-refresh-custom="autoRefreshCustom"
              :paged="pagedViews"
              list
            />
            <SettingsSection
              :title="t('designer.layoutViews.heading')"
              :description="t('designer.layoutViews.description')"
            >
              <DataViewViewsAccordion
                v-model:layouts="layouts"
                v-model:main-view="mainView"
                :available="availableLayouts"
                :invalid="viewInvalid"
              >
                <template #view="{ type }">
                  <DataViewViewSettings
                    v-model:features="featureFlags"
                    :type="type"
                  >
                    <LazyDataViewCardSettings
                      v-if="type === 'CARDS' && cardLayout"
                      v-model="cardLayout"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                    />
                    <LazyDataViewMapSettings
                      v-else-if="type === 'MAP' && mapLayout"
                      v-model="mapLayout"
                      v-model:view="mapView"
                      :column-fields="columnFields"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                    />
                    <LazyDataViewKanbanSettings
                      v-else-if="type === 'KANBAN' && kanbanLayout"
                      v-model="kanbanLayout"
                      :column-fields="columnFields"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                      :check-list-columns="checkListColumns"
                    />
                    <LazyDataViewCalendarSettings
                      v-else-if="type === 'CALENDAR' && calendarLayout"
                      v-model="calendarLayout"
                      :column-fields="columnFields"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                    />
                    <LazyDataViewGanttSettings
                      v-else-if="type === 'GANTT' && ganttLayout"
                      v-model="ganttLayout"
                      :column-fields="columnFields"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                    />
                    <LazyDataViewTreeSettings
                      v-else-if="type === 'TREE' && treeLayout"
                      v-model="treeLayout"
                      :column-fields="columnFields"
                      :binding-columns="bindingColumns"
                      :relations="relationDetail?.relations"
                      :self-references="selfReferences"
                    />
                  </DataViewViewSettings>
                </template>
              </DataViewViewsAccordion>
            </SettingsSection>
          </div>

          <!-- Form: how the record form opens and the record's actions. -->
          <div
            v-if="visitedSections.has('form') && dataview && hasGridSource"
            v-show="section === 'form'"
            class="flex flex-col gap-8"
          >
            <DataViewFormSettings
              v-model:features="featureFlags"
              v-model:edit-presentation="editPresentation"
              v-model:edit-size="editSize"
              v-model:edit-side="editSide"
              v-model:form-view-mode="formViewMode"
              v-model:master-detail-open-with="masterDetailOpenWith"
              v-model:new-record-label="newRecordLabel"
              v-model:page-content-width="pageContentWidth"
              v-model:page-content-align="pageContentAlign"
              v-model:fit-to-screen="fitToScreen"
              :dataview="dataview"
              :name="name"
              :allow="allow"
              :designable="canDesign"
              @design="openDesignForm"
            />
          </div>

          <!-- Actions: what a viewer can do - Allow, then the toolbar's buttons. -->
          <div
            v-if="visitedSections.has('actions') && dataview && hasGridSource"
            v-show="section === 'actions'"
            class="flex flex-col gap-8"
          >
            <DataViewActionsSettings
              v-model:allow="allow"
              v-model:features="featureFlags"
              :view-type="dataview.viewType"
              :writable="dataview.sourceResourceType === 'TABLE'"
            />
            <DataViewCustomActions
              v-if="hasGridSource"
              v-model="customActions"
              :columns="bindingColumns"
              :primary-key="primaryKey ?? null"
            />
          </div>

          <!-- Security: which roles open it - object access, never data (AGENTS.md section 13); applies at once. -->
          <div
            v-if="visitedSections.has('security') && dataview"
            v-show="section === 'security'"
            class="flex flex-col gap-8"
          >
            <ObjectSecuritySettings
              kind="dataview"
              :object-id="id"
              :source-resource="dataview.sourceResourceType === 'TABLE' || dataview.sourceResourceType === 'VIEW' ? dataview.sourceResource : null"
              :source-name="dataview.sourceResourceName ?? undefined"
              :allow="hasGridSource ? allow : undefined"
              :allow-link="hasGridSource ? allowLink : undefined"
            />
          </div>

          <!-- Versions (Specification.md §13.7): the history, a version opened read-only here, restored or saved as. -->
          <VersionsTimeline
            v-if="visitedSections.has('versions') && dataview"
            v-show="section === 'versions'"
            pillar="dataviews"
            :object-id="id"
            :object-name="dataview.name"
            :versions="versions ?? []"
            :has-unpublished-changes="hasUnpublishedChanges"
            :publishing="publishing"
            :publish-note="t('designer.settingsPage.publishNote')"
            :before-restore="() => autosave.flush()"
            @open="selectVersion"
            @publish="publish"
            @restored="onRestored"
            @deleted="onVersionsDeleted"
          />

          <!-- Page: EXTERNALFRAME's frame (no columns, design or filter); a CUSTOM page's width (Specification_DataViews.md §6.7). -->
          <div
            v-if="visitedSections.has('page')"
            v-show="section === 'page'"
            class="flex flex-col gap-8"
          >
            <SettingsSection
              v-if="isFrame"
              :title="t('designer.settingsPage.frame')"
            >
              <DataViewFrameSettings
                v-model:url="frameUrl"
                v-model:features="featureFlags"
              />
            </SettingsSection>
            <SettingsSection
              v-if="isCustom"
              :title="t('designer.settingsPage.page')"
            >
              <DataViewPageWidthSettings
                v-model:width="pageContentWidth"
                v-model:align="pageContentAlign"
                page="custom"
              />
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-sm">
                    {{ t('designer.featuresSettings.kiosk') }}
                  </p>
                  <p class="text-xs text-muted">
                    {{ t('designer.featuresSettings.kioskDescription') }}
                  </p>
                </div>
                <USwitch
                  v-model="kiosk"
                  :aria-label="t('designer.featuresSettings.kiosk')"
                />
              </div>
            </SettingsSection>
          </div>

          <!-- Layout: a SETTINGS DataView's columns, and its refresh. -->
          <div
            v-if="visitedSections.has('layout') && dataview && settingsLayout"
            v-show="section === 'layout'"
            class="flex flex-col gap-8"
          >
            <SettingsSection :title="t('designer.settingsLayout.heading')">
              <DataViewSettingsLayoutFields
                v-model="settingsLayout"
                :columns="bindingColumns.map(c => ({ name: c.name, label: c.name }))"
              />
            </SettingsSection>
            <DataViewPresentationSettings
              v-model:default-density="defaultDensity"
              v-model:default-page-size="defaultPageSize"
              v-model:default-toolbar-mode="defaultToolbarMode"
              v-model:list-margin="listMargin"
              v-model:auto-refresh-preset="autoRefreshPreset"
              v-model:auto-refresh-custom="autoRefreshCustom"
              :paged="false"
              :list="false"
            />
          </div>
        </div>
      </div>
    </template>

    <UModal
      v-model:open="deleteOpen"
      :title="t('designer.settingsPage.deleteTitle')"
      :description="t('designer.settingsPage.deleteDescription')"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteDataview"
            />
          </div>
        </div>
      </template>
    </UModal>
    <DataViewPreviewDrawer
      v-if="draftPreviewMounted && dataview"
      v-model:open="draftPreviewOpen"
      :dataview-id="dataview.id"
      :has-unpublished-changes="hasUnpublishedChanges"
      :live-version="liveVersion"
      :publishing="publishing"
      @publish="publishFromPreview"
    />
    <VersionSaveAsModal
      v-if="previewVersion && dataview"
      v-model:open="saveAsOpen"
      :source-label="`${dataview.name} v${previewVersion.version}`"
      :loading="savingAs"
      @submit="saveAs"
    />
    <DeleteVersionsModal
      v-model:open="deleteVersionsOpen"
      pillar="dataviews"
      :object-id="id"
      :versions="versions ?? []"
      @deleted="onVersionsDeleted"
    />
  </PageShell>
</template>
