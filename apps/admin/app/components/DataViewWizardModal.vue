<script setup lang="ts">
/**
 * DataView creation wizard (DataViews.md §3.1) on the product's WizardModal (AGENTS.md "Multi-step
 * wizards"). Its steps are the settings page's sections, in their order and with their components (§3.6): Type
 * (only here - grouped by what each is for) · General · Data · Views · Form · Actions · Security. A step that
 * doesn't apply is skipped: a page and a frame have no Views, Form or Actions; SETTINGS no Views or Form.
 */
import type { RelationDetail } from '~/types/schema'
import type { WizardStep } from '~/components/WizardModal.vue'
import {
  DATAVIEW_FEATURES,
  DATAVIEW_TYPE_META,
  DEFAULT_MAP_VIEW,
  EDIT_PRESENTATION_META,
  LIST_DATAVIEW_TYPES,
  SETTINGS_LAYOUT_KEYS,
  looksLikeSettingsTable,
  settingsLayoutComplete,
  suggestSettingsLayout,
  type SettingsLayoutConfig,
  type ColumnSync,
  type CreateDataViewBody,
  type DataView,
  type DataViewType,
  type DetailCandidate,
  type EditPresentation,
  type EditSide,
  type EditSize,
  type FormViewMode,
  type MapViewConfig,
  type MasterDetailOpenWith,
  type PageContentAlign,
  type PageContentWidth,
  dataviewMetaKey,
  mapLocationReady
} from '~/types/dataview'

import type { RoleColor } from '~/types/permission'
import { defaultEditPresentation, MANY_FIELDS_THRESHOLD } from '@totalbase/tb-catalog'
import type { WizardColumnRow } from '~/components/DataViewWizardColumns.vue'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'
import { embeddableFrameUrl } from '~/utils/frame-url'

const props = defineProps<{ open: boolean, initialResourceId?: string }>()
const emit = defineEmits<{ 'update:open': [boolean], 'created': [DataView] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const catalogText = useCatalogText()
const apiErrorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const W = 'designer.dataViewWizardModal'

// --- Step 1: type ---
const viewType = ref<DataViewType | undefined>(undefined)
const typeStepValid = computed(() => viewType.value !== undefined)
/** The types by what each is for - many rows (from what serves any table to what needs a special column), one record, a page of its own. */
const TYPE_GROUPS: { key: 'rows' | 'record' | 'pages', types: DataViewType[] }[] = [
  { key: 'rows', types: LIST_DATAVIEW_TYPES },
  { key: 'record', types: ['FORM', 'MASTER_DETAIL', 'SETTINGS'] },
  { key: 'pages', types: ['CUSTOM', 'EXTERNALFRAME'] }
]
/** What a type needs of its table - said up front, not found out at the Data step. */
const TYPE_NEEDS: Partial<Record<DataViewType, string>> = { CALENDAR: 'date', GANTT: 'range', MAP: 'location', KANBAN: 'status', TREE: 'parent' }
const typeGroups = computed(() => TYPE_GROUPS.map(group => ({
  key: group.key,
  options: group.types.map(key => ({
    value: key,
    icon: DATAVIEW_TYPE_META[key].icon,
    label: catalogText(dataviewMetaKey('types', key, 'label'), DATAVIEW_TYPE_META[key].label),
    description: catalogText(dataviewMetaKey('types', key, 'description'), DATAVIEW_TYPE_META[key].description),
    needs: TYPE_NEEDS[key] ? t(`${W}.needs.${TYPE_NEEDS[key]}`) : null,
    recommended: key === 'TABLE'
  }))
})))

// --- Step 2: identity ---
const name = ref('')
const description = ref<string | null>(null)
const slug = ref('')
const slugTouched = ref(false)
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)

// Name and slug are required; description is optional, as everywhere else (AGENTS.md section 10.1) and in Settings.
const identityStepValid = computed(() => name.value.trim().length > 0 && slug.value.trim().length > 0)

watch(viewType, (type) => {
  if (type && !icon.value) icon.value = DATAVIEW_TYPE_META[type].icon
})

// --- Step 3: source ---
// The shared registry - the wizard mounts on first open (its callers load it
// lazily), and the source list fills in as soon as it arrives.
const { resources } = useResourcesList()

// `exposedMethods.includes('GET')` - a DataView can't function without being
// able to at least read rows from its source.
const sourceOptions = computed(() =>
  (resources.value ?? [])
    // A Master-detail's master and a page's record are tables - their record is created and written.
    .filter(r => r.status === 'ACTIVE' && (r.type === 'TABLE' || (r.type === 'VIEW' && viewType.value !== 'MASTER_DETAIL' && viewType.value !== 'CUSTOM')) && r.exposedMethods.includes('GET'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label))
)
const sourceResourceId = ref<string | undefined>(undefined)
/** A page's record table is optional. */
const sourceStepValid = computed(() => viewType.value === 'CUSTOM' || Boolean(sourceResourceId.value))
const selectedResource = computed(() => resources.value?.find(r => r.id === sourceResourceId.value))

// --- Master-detail: the Detail step ---
// The tables whose FK points at the master (the server reads them off
// pg_catalog) - one is picked for the Detail control the DataView is created with.
const detailCandidates = ref<DetailCandidate[]>([])
const detailCandidatesLoading = ref(false)
/** `resourceId:fkColumn` - one table may reference the master through two columns. */
const detailChoice = ref<string | undefined>(undefined)
watch([sourceResourceId, viewType], async ([masterId, type]) => {
  detailCandidates.value = []
  detailChoice.value = undefined
  if (type !== 'MASTER_DETAIL' || !masterId) return
  detailCandidatesLoading.value = true
  try {
    detailCandidates.value = (await api.get<DetailCandidate[]>('/dataviews/detail-candidates', { master: masterId })).data
    if (detailCandidates.value.length === 1) detailChoice.value = detailKey(detailCandidates.value[0]!)
  } finally {
    detailCandidatesLoading.value = false
  }
})
function detailKey(candidate: DetailCandidate): string {
  return `${candidate.resourceId}:${candidate.fkColumn}`
}
const detailItems = computed(() => detailCandidates.value.map(c => ({
  label: `${c.schema}.${c.table}`,
  description: t(`${W}.byColumn`, { column: c.fkColumn }),
  value: detailKey(c)
})))
const selectedDetail = computed(() => detailCandidates.value.find(c => detailKey(c) === detailChoice.value))
const detailStepValid = computed(() => Boolean(selectedDetail.value))

// --- Step 4: columns ---
// One row per source column, editable inline - visible, Title (defaults
// to a humanized column name), Help (optional, shown under the widget in
// the Edit form), and Control (defaults to the same inference the server
// would apply, editable here so re-opening the Design form just to fix a
// label/widget isn't required for the common case).
const columnsLoading = ref(false)
const relationDetail = ref<RelationDetail | null>(null)
/** The Columns step (DataViewWizardColumns.vue): every column of the source, all chosen by default. */
const columnRows = ref<WizardColumnRow[]>([])
/** `view_config.column_sync` (types/dataview.ts's own doc comment) - what happens to a column the table gains later, or an existing one nobody selected here. Editable later from the Design form toolbar too. */
const columnSync = ref<ColumnSync>('auto_show')
/** A Master-detail's detail rows: their columns - its grid and each row's form - all chosen by default. */
const detailColumnRows = ref<WizardColumnRow[]>([])
const detailResource = computed(() => resources.value?.find(r => r.id === selectedDetail.value?.resourceId) ?? null)
const detailColumnsStepValid = computed(() => detailColumnRows.value.some(c => c.visible))

const columnsStepValid = computed(() => columnRows.value.some(c => c.visible))

// --- Features: every switch of the type's catalog, at its default - Views, Form and Actions edit them.
const features = ref<Record<string, boolean>>({})
watch(viewType, (type) => {
  const catalog = type ? DATAVIEW_FEATURES[type] ?? [] : []
  features.value = Object.fromEntries(catalog.map(f => [f.key, f.default]))
}, { immediate: true })

// How the Edit form opens (DataViews.md §6.3) - same setting the Design form's
// "View settings" section edits later; the wizard just picks a starting
// value instead of leaving every new DataView to default silently.
const editPresentation = ref<EditPresentation>('SIDEBAR')
/** Until the author picks one, it follows how many fields the form has (DataViews.md §6.3): a Page past the threshold. */
const editPresentationChosen = ref(false)
function chooseEditPresentation(value: EditPresentation) {
  editPresentation.value = value
  editPresentationChosen.value = true
}
watch(() => columnRows.value.filter(c => c.visible).length, (count) => {
  if (!editPresentationChosen.value) editPresentation.value = defaultEditPresentation(count)
})
const editSize = ref<EditSize | null>(null)
const editSide = ref<EditSide>('right')
const presentationLabel = (key: EditPresentation) => catalogText(dataviewMetaKey('editPresentations', key, 'label'), EDIT_PRESENTATION_META[key].label)
/** Many fields in a Sidebar or a Modal - one column, lots of scrolling: a Page, like the Settings pages, fits better. */
const manyColumnsNudge = computed(() => viewType.value !== 'FORM' && (editPresentation.value === 'SIDEBAR' || editPresentation.value === 'MODAL') && columnRows.value.filter(c => c.visible).length > MANY_FIELDS_THRESHOLD)
/** FORM only - `view_config.form_view_mode` (types/dataview.ts's own doc comment). Meaningless for every other type - TABLE's own "Mode" select just above picks `editPresentation` instead. */
const formViewMode = ref<FormViewMode>('READ')
const masterDetailOpenWith = ref<MasterDetailOpenWith>('NEW_RECORD')
const newRecordLabel = ref('')
const pageContentWidth = ref<PageContentWidth | null>(null)
const pageContentAlign = ref<PageContentAlign | null>(null)
const fitToScreen = ref(false)

// --- Views: what every view shares (DataViewPresentationSettings) - '' / 0 / 'off' leave each to its default.
const defaultDensity = ref('')
const defaultPageSize = ref(0)
const defaultToolbarMode = ref('')
const listMargin = ref('')
const autoRefreshPreset = ref('off')
const autoRefreshCustom = ref('')

// --- Actions: Allow (DataViewActionsSettings) - all three by default.
const ALLOW_ACTIONS = ['create', 'update', 'delete'] as const
const allow = ref<string[]>([...ALLOW_ACTIONS])

// --- Security: the roles that open it (ObjectRolesList) - granted once it's created.
const { data: allRoles } = useRoleOptions()
const roleIds = ref<string[]>([])

// --- Layout steps (CARDS/MAP/KANBAN/CALENDAR/GANTT) - one lazy
// DataViewWizard<Type>Step.vue each, bound to the same typed config Edit
// DataView edits later, picked from plain columns (a pick is stored as the
// bare formula `{{column}}` - utils/dataview-wizard-layouts.ts). Re-picked
// whenever the Columns step changes, so an excluded column never stays
// mapped and a required slot always has a default - even while its step
// isn't showing.
const visibleColumns = computed<WizardColumn[]>(() => columnRows.value.filter(c => c.visible))
const cardLayout = ref(emptyCardLayout())
const mapLayout = ref(emptyMapLayout())
const mapView = ref<MapViewConfig>({ ...DEFAULT_MAP_VIEW })
const kanbanLayout = ref(emptyKanbanLayout())
const calendarLayout = ref(emptyCalendarLayout())
const ganttLayout = ref(emptyGanttLayout())
const treeLayout = ref(emptyTreeLayout())
/** TREE: a trigger refusing a row under itself or its descendants - added to the table when it's created (§5.14). */
const treeCycleGuard = ref(true)
/** SETTINGS: its columns, proposed from their names (types/dataview.ts suggestSettingsLayout) - an empty slot filled, a pick kept. */
const settingsLayout = ref<SettingsLayoutConfig>(suggestSettingsLayout([]))
watch([viewType, columnRows], ([type, rows]) => {
  if (type !== 'SETTINGS') return
  const names = rows.map(r => r.name)
  const proposed = suggestSettingsLayout(names)
  const kept = Object.fromEntries(SETTINGS_LAYOUT_KEYS.map(key => [key, settingsLayout.value[key] && names.includes(settingsLayout.value[key]!) ? settingsLayout.value[key] : proposed[key]]))
  settingsLayout.value = kept as unknown as SettingsLayoutConfig
}, { immediate: true })
const settingsLayoutStepValid = computed(() => settingsLayoutComplete(settingsLayout.value))
/** A table shaped like parameters, picked for another type: the Source step suggests SETTINGS. */
const suggestsSettings = computed(() => viewType.value !== 'SETTINGS' && viewType.value !== 'CUSTOM' && viewType.value !== 'MASTER_DETAIL' && columnRows.value.length > 0 && looksLikeSettingsTable(columnRows.value.map(r => r.name)))
watch([viewType, visibleColumns], ([type, columns]) => {
  if (type === 'CARDS') cardLayout.value = pickCardLayout(cardLayout.value, columns)
  if (type === 'MAP') mapLayout.value = pickMapLayout(mapLayout.value, columns)
  if (type === 'KANBAN') kanbanLayout.value = pickKanbanLayout(kanbanLayout.value, columns)
  if (type === 'CALENDAR') calendarLayout.value = pickCalendarLayout(calendarLayout.value, columns)
  if (type === 'GANTT') ganttLayout.value = pickGanttLayout(ganttLayout.value, columns)
  if (type === 'TREE') treeLayout.value = pickTreeLayout(treeLayout.value, columns, columnRows.value)
})
const cardLayoutStepValid = computed(() => !!cardLayout.value.titleFormula)
const mapLayoutStepValid = computed(() => mapLocationReady(mapLayout.value) && !!mapLayout.value.nameFormula)
const kanbanLayoutStepValid = computed(() => !!kanbanLayout.value.groupColumn)
const calendarLayoutStepValid = computed(() => !!(calendarLayout.value.dateColumn && calendarLayout.value.titleFormula))
const ganttLayoutStepValid = computed(() => !!(ganttLayout.value.startDateColumn && ganttLayout.value.endDateColumn))
const treeLayoutStepValid = computed(() => !!(treeLayout.value.parentColumn && treeLayout.value.titleFormula))

// --- EXTERNALFRAME: no source, columns or layout - one Frame step (URL,
// its two features, a live preview) after Identity.
const frameUrl = ref('')
const frameStepValid = computed(() => embeddableFrameUrl(frameUrl.value) !== null)

// --- Steps / navigation ---
type StepKey = 'type' | 'general' | 'data' | 'detail' | 'detailColumns' | 'frame' | 'settingsLayout' | 'views' | 'form' | 'actions' | 'security'
/** A step's title and description - 'master'/'record' retitle Data for a Master-detail or a page. */
const stepMeta = (key: StepKey | 'master' | 'record') => ({ title: t(`${W}.steps.${key}.title`), description: t(`${W}.steps.${key}.description`) })
const isList = computed(() => !!viewType.value && LIST_DATAVIEW_TYPES.includes(viewType.value))
const stepKeys = computed<StepKey[]>(() => {
  const type = viewType.value
  if (type === 'EXTERNALFRAME') return ['type', 'general', 'frame', 'security']
  // Widgets, variables and code are all built in the Design form.
  if (type === 'CUSTOM') return ['type', 'general', 'data', 'security']
  // Everything else - totals, buttons, the line form - is laid out in the Design form.
  if (type === 'MASTER_DETAIL') return ['type', 'general', 'data', 'detail', 'detailColumns', 'form', 'actions', 'security']
  // Its columns are the layout's - no Columns, no record form.
  if (type === 'SETTINGS') return ['type', 'general', 'data', 'settingsLayout', 'actions', 'security']
  if (type === 'FORM') return ['type', 'general', 'data', 'form', 'actions', 'security']
  return ['type', 'general', 'data', 'views', 'form', 'actions', 'security']
})
/** Views: the main view's layout - what it needs of the columns. */
const LAYOUT_VALID: Partial<Record<DataViewType, ComputedRef<boolean>>> = {
  CARDS: cardLayoutStepValid,
  MAP: mapLayoutStepValid,
  KANBAN: kanbanLayoutStepValid,
  CALENDAR: calendarLayoutStepValid,
  GANTT: ganttLayoutStepValid,
  TREE: treeLayoutStepValid
}
/** Data: the source, and - over a table or a view - at least one column shown (SETTINGS' columns are its layout's). */
const dataStepValid = computed(() => sourceStepValid.value && (viewType.value === 'CUSTOM' || viewType.value === 'SETTINGS' || columnsStepValid.value))
const STEP_VALID: Record<StepKey, ComputedRef<boolean>> = {
  type: typeStepValid,
  general: identityStepValid,
  data: dataStepValid,
  detail: detailStepValid,
  detailColumns: detailColumnsStepValid,
  frame: frameStepValid,
  settingsLayout: settingsLayoutStepValid,
  views: computed(() => (viewType.value ? LAYOUT_VALID[viewType.value]?.value ?? true : true)),
  form: computed(() => true),
  actions: computed(() => true),
  security: computed(() => true)
}
// --- Preview: what the DataView will read (DataViews.md §4) - the
// selected columns, always with the primary key, ordered by it. A Filter
// and a default sort come later, in Settings.
const dataApi = useDataApi()
const previewOpen = ref(false)
const previewPath = computed(() => {
  const resource = selectedResource.value
  return resource ? dataApi.resourcePath(resource.schema, resource.name, resource.type === 'VIEW' ? 'view' : 'table') : null
})
const previewQuery = computed<Record<string, unknown>>(() => {
  const read = columnRows.value.filter(c => c.visible || c.primaryKey)
  const primaryKey = columnRows.value.filter(c => c.primaryKey).map(c => c.name)
  return {
    fields: read.map(c => c.name).join(','),
    ...(primaryKey.length ? { order_by: primaryKey.join(',') } : {})
  }
})

/** Master-detail's Data step picks the master table; a page's, its record's table. */
const steps = computed<WizardStep[]>(() => stepKeys.value.map(key => ({
  key,
  ...(key === 'data' && viewType.value === 'MASTER_DETAIL' ? stepMeta('master') : key === 'data' && viewType.value === 'CUSTOM' ? stepMeta('record') : stepMeta(key)),
  valid: STEP_VALID[key].value
})))
const wizardOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value)
})

function reset() {
  viewType.value = undefined
  name.value = ''
  description.value = null
  slug.value = ''
  slugTouched.value = false
  icon.value = undefined
  color.value = undefined
  sourceResourceId.value = props.initialResourceId
  relationDetail.value = null
  columnRows.value = []
  columnSync.value = 'auto_show'
  features.value = {}
  editPresentation.value = 'SIDEBAR'
  editPresentationChosen.value = false
  editSize.value = null
  editSide.value = 'right'
  formViewMode.value = 'READ'
  masterDetailOpenWith.value = 'NEW_RECORD'
  newRecordLabel.value = ''
  pageContentWidth.value = null
  pageContentAlign.value = null
  fitToScreen.value = false
  defaultDensity.value = ''
  defaultPageSize.value = 0
  defaultToolbarMode.value = ''
  listMargin.value = ''
  autoRefreshPreset.value = 'off'
  autoRefreshCustom.value = ''
  allow.value = [...ALLOW_ACTIONS]
  roleIds.value = []
  cardLayout.value = emptyCardLayout()
  mapLayout.value = emptyMapLayout()
  mapView.value = { ...DEFAULT_MAP_VIEW }
  kanbanLayout.value = emptyKanbanLayout()
  calendarLayout.value = emptyCalendarLayout()
  ganttLayout.value = emptyGanttLayout()
  treeLayout.value = emptyTreeLayout()
  treeCycleGuard.value = true
  frameUrl.value = ''
}

// Immediate: the wizard is mounted already open the first time.
watch(() => props.open, (isOpen) => {
  if (isOpen) reset()
}, { immediate: true })

const creating = ref(false)
/** Security's roles, granted once it exists - a failure leaves the DataView there, with a warning. */
async function grantRoles(dataview: DataView) {
  if (roleIds.value.length === 0) return
  try {
    await api.put(`/dataviews/${dataview.id}/roles`, { data: { roleIds: roleIds.value } })
  } catch (err) {
    toast.add({ title: t(`${W}.rolesError`), description: apiErrorMessage(err, t('common.unknownError')), color: 'warning' })
  }
}
/** What Views, Form and Actions set - only what differs from the defaults, so a new DataView stores no more than it chose. */
function chosenSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (allow.value.length < ALLOW_ACTIONS.length) out.allow = allow.value
  const autoRefresh = autoRefreshPreset.value === 'custom' ? autoRefreshCustom.value.trim() : autoRefreshPreset.value === 'off' ? '' : autoRefreshPreset.value
  if (autoRefresh) out.auto_refresh = autoRefresh
  if (listMargin.value) out.list_margin = listMargin.value
  if (pageContentWidth.value) out.page_content_width = pageContentWidth.value
  if (pageContentAlign.value) out.page_content_align = pageContentAlign.value
  if (fitToScreen.value) out.fit_to_screen = true
  if (viewType.value === 'MASTER_DETAIL') {
    if (masterDetailOpenWith.value !== 'NEW_RECORD') out.open_with = masterDetailOpenWith.value
    if (newRecordLabel.value.trim()) out.new_record_label = newRecordLabel.value.trim()
  }
  return out
}
/** `default_state`'s first-visit choices - the density, page size and toolbar a first-time viewer starts with. */
function chosenDefaultState(): Record<string, unknown> {
  return {
    ...(defaultDensity.value ? { density: defaultDensity.value } : {}),
    ...(defaultPageSize.value ? { pageSize: defaultPageSize.value } : {}),
    ...(defaultToolbarMode.value ? { toolbarMode: defaultToolbarMode.value } : {})
  }
}
/** The DataView is there either way: a guard that can't be added (the table's owner, its key) is a warning. */
async function addCycleGuard() {
  const resource = selectedResource.value
  if (!resource || !treeLayout.value.parentColumn) return
  try {
    await api.post(`/schema/${encodeURIComponent(resource.schema)}/tables/${encodeURIComponent(resource.name)}/cycle-guard`, { data: { parentColumn: treeLayout.value.parentColumn } })
  } catch (err) {
    toast.add({ title: t(`${W}.cycleGuardError`), description: apiErrorMessage(err, t('common.unknownError')), color: 'warning' })
  }
}
async function createFrame() {
  creating.value = true
  try {
    const { data } = await api.post<DataView>('/dataviews', {
      data: {
        name: name.value,
        slug: slug.value,
        description: description.value,
        icon: icon.value ?? null,
        color: color.value ?? null,
        viewType: 'EXTERNALFRAME',
        viewConfig: { frame_url: frameUrl.value.trim(), features: features.value }
      } satisfies CreateDataViewBody
    })
    await grantRoles(data)
    toast.add({ title: t(`${W}.created`), color: 'success' })
    emit('created', data)
    emit('update:open', false)
  } catch (err) {
    notifyError(err, t(`${W}.createError`))
  } finally {
    creating.value = false
  }
}
async function createCustom() {
  creating.value = true
  try {
    const { data } = await api.post<DataView>('/dataviews', {
      data: {
        name: name.value,
        slug: slug.value,
        description: description.value,
        icon: icon.value ?? null,
        color: color.value ?? null,
        viewType: 'CUSTOM',
        sourceResourceId: sourceResourceId.value,
        viewConfig: { variables: [] }
      } satisfies CreateDataViewBody
    })
    await grantRoles(data)
    toast.add({ title: t(`${W}.created`), color: 'success' })
    emit('created', data)
    emit('update:open', false)
  } catch (err) {
    notifyError(err, t(`${W}.createError`))
  } finally {
    creating.value = false
  }
}
/** Each column's control and help as the Columns step left them - its title is its table's column's. */
function fieldOverridesOf(rows: readonly WizardColumnRow[]): NonNullable<CreateDataViewBody['fieldOverrides']> {
  return Object.fromEntries(rows.map(c => [c.name, {
    // Only a widget picked here: left as its column's, the form follows the column (DataViews.md §15.2).
    ...(c.widget !== c.columnWidget ? { widget: c.widget } : {}),
    ...(c.help.trim() ? { help: c.help.trim() } : {})
  }]))
}
async function createMasterDetail() {
  if (!sourceResourceId.value || !selectedDetail.value) return
  creating.value = true
  try {
    const { data } = await api.post<DataView>('/dataviews', {
      data: {
        name: name.value,
        slug: slug.value,
        description: description.value,
        icon: icon.value ?? null,
        color: color.value ?? null,
        sourceResourceId: sourceResourceId.value,
        viewType: 'MASTER_DETAIL',
        viewConfig: { features: features.value, ...chosenSettings() },
        selectedColumns: columnRows.value.filter(c => c.visible).map(c => c.name),
        fieldOverrides: fieldOverridesOf(columnRows.value),
        detail: {
          resourceId: selectedDetail.value.resourceId,
          fkColumn: selectedDetail.value.fkColumn,
          selectedColumns: detailColumnRows.value.filter(c => c.visible).map(c => c.name),
          fieldOverrides: fieldOverridesOf(detailColumnRows.value)
        }
      } satisfies CreateDataViewBody
    })
    await grantRoles(data)
    toast.add({ title: t(`${W}.created`), color: 'success' })
    emit('created', data)
    emit('update:open', false)
  } catch (err) {
    notifyError(err, t(`${W}.createError`))
  } finally {
    creating.value = false
  }
}
async function create() {
  if (viewType.value === 'EXTERNALFRAME') return createFrame()
  if (viewType.value === 'CUSTOM') return createCustom()
  if (viewType.value === 'MASTER_DETAIL') return createMasterDetail()
  if (!sourceResourceId.value || !viewType.value) return
  creating.value = true
  try {
    const body: CreateDataViewBody = {
      name: name.value,
      slug: slug.value,
      description: description.value,
      icon: icon.value ?? null,
      color: color.value ?? null,
      sourceResourceId: sourceResourceId.value,
      viewType: viewType.value,
      selectedColumns: columnRows.value.filter(c => c.visible).map(c => c.name),
      viewConfig: {
        features: features.value,
        ...chosenSettings(),
        ...(viewType.value === 'FORM'
          ? { form_view_mode: formViewMode.value }
          : { edit_presentation: editPresentation.value, edit_size: editSize.value, edit_side: editSide.value }),
        ...(viewType.value === 'CARDS' ? { card_layout: cardLayout.value } : {}),
        ...(viewType.value === 'MAP' ? { map_layout: mapLayout.value, map_view: mapView.value } : {}),
        ...(viewType.value === 'KANBAN' ? { kanban_layout: kanbanLayout.value } : {}),
        ...(viewType.value === 'GANTT' ? { gantt_layout: ganttLayout.value } : {}),
        ...(viewType.value === 'TREE' ? { tree_layout: treeLayout.value } : {}),
        ...(viewType.value === 'CALENDAR' ? { calendar_layout: calendarLayout.value } : {}),
        ...(viewType.value === 'SETTINGS' ? { settings_layout: settingsLayout.value } : {}),
        column_sync: columnSync.value,
        // Seeds `default_state` (types/dataview.ts's own doc comment)
        // from this step's own column list/order/visibility, so a brand
        // new DataView already has a real default instead of leaving
        // every viewer on raw DB column order until someone remembers
        // to visit the grid and click "Set as default for everyone".
        // No `sort`/`density` here - the wizard never asks for either.
        default_state: {
          ...chosenDefaultState(),
          columnPrefs: Object.fromEntries(columnRows.value.map((c, i) => [c.name, { visible: c.visible, order: i }]))
        }
      },
      // Always sent (not just for edited rows) - the wizard's own
      // humanized Title is the whole point of this step, not merely a
      // fallback shown while the wizard is open. `widget` too: it already
      // starts from the column's stored widget (see the Columns load
      // above), so what the builder sees here is exactly what's created.
      fieldOverrides: fieldOverridesOf(columnRows.value)
    }
    const { data } = await api.post<DataView>('/dataviews', { data: body })
    await grantRoles(data)
    toast.add({ title: t(`${W}.created`), color: 'success' })
    if (viewType.value === 'TREE' && treeCycleGuard.value) await addCycleGuard()
    emit('created', data)
    emit('update:open', false)
  } catch (err) {
    notifyError(err, t(`${W}.createError`))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <WizardModal
    v-model:open="wizardOpen"
    :title="t(`${W}.title`)"
    :steps="steps"
    :submit-label="t('common.create')"
    :submitting="creating"
    width="max-w-5xl"
    @submit="create"
  >
    <template #type>
      <div class="flex flex-col gap-6">
        <section
          v-for="group in typeGroups"
          :key="group.key"
          class="flex flex-col gap-2"
        >
          <div>
            <h4 class="text-xs font-semibold uppercase tracking-wide text-highlighted">
              {{ t(`${W}.typeGroups.${group.key}.title`) }}
            </h4>
            <p
              v-if="group.key === 'rows'"
              class="text-xs text-muted"
            >
              {{ t(`${W}.typeGroups.rows.note`) }}
            </p>
          </div>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <button
              v-for="opt in group.options"
              :key="opt.value"
              type="button"
              class="relative rounded-lg border p-4 text-left transition-colors"
              :class="viewType === opt.value ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated'"
              @click="viewType = opt.value"
            >
              <UIcon
                :name="opt.icon"
                class="mb-2 size-6"
                :class="viewType === opt.value ? 'text-primary' : 'text-muted'"
              />
              <p class="text-sm font-semibold text-highlighted">
                {{ opt.label }}
              </p>
              <p class="text-xs text-muted">
                {{ opt.description }}
              </p>
              <p
                v-if="opt.needs"
                class="mt-1 flex items-center gap-1 text-xs text-dimmed"
              >
                <UIcon
                  name="i-lucide-info"
                  class="size-3.5 shrink-0"
                />
                {{ opt.needs }}
              </p>
              <!-- Last in the DOM, so the card is named by its type first. -->
              <UBadge
                v-if="opt.recommended"
                :label="t(`${W}.recommended`)"
                size="xs"
                color="primary"
                variant="subtle"
                class="absolute right-2 top-2"
              />
            </button>
          </div>
        </section>
      </div>
    </template>

    <template #general>
      <NameSlugFields
        v-model:name="name"
        v-model:description="description"
        v-model:slug="slug"
        v-model:slug-touched="slugTouched"
      />
      <div class="flex gap-3">
        <IconPickerField
          v-model="icon"
          :label="t('common.icon')"
          options="lucide"
        />
        <ColorPickerField
          v-model="color"
          :label="t('common.color')"
          allow-none
        />
      </div>
    </template>

    <template #data>
      <div class="flex flex-col gap-6">
        <UFormField
          :label="viewType === 'MASTER_DETAIL' ? t(`${W}.masterTable`) : viewType === 'CUSTOM' ? t(`${W}.recordTable`) : t(`${W}.tableOrView`)"
          :description="viewType === 'MASTER_DETAIL'
            ? t(`${W}.masterTableHelp`)
            : viewType === 'CUSTOM'
              ? t(`${W}.recordTableHelp`, { variable: 'dataview.vars.record', param: '?pk=' })
              : t(`${W}.tableOrViewHelp`)"
        >
          <USelectMenu
            v-model="sourceResourceId"
            :items="sourceOptions"
            value-key="value"
            searchable
            :clear="viewType === 'CUSTOM'"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="suggestsSettings"
          color="info"
          variant="subtle"
          icon="i-lucide-sliders-horizontal"
          :description="t('designer.settingsLayout.suggest')"
          :actions="[{ label: t('designer.settingsLayout.useSettings'), color: 'info', variant: 'outline', onClick: () => { viewType = 'SETTINGS' } }]"
        />
        <!-- Over a table or a view: its columns, what a new one does, and the query it reads. -->
        <template v-if="selectedResource && viewType !== 'CUSTOM'">
          <section
            v-if="viewType !== 'SETTINGS'"
            class="flex flex-col gap-3"
          >
            <p class="text-sm text-muted">
              <i18n-t
                :keypath="`${W}.columnsIntro`"
                tag="span"
              >
                <template #resource>
                  <span class="font-mono">{{ selectedResource.schema }}.{{ selectedResource.name }}</span>
                </template>
              </i18n-t>
            </p>
            <DataViewWizardColumns
              v-model:rows="columnRows"
              v-model:loading="columnsLoading"
              v-model:detail="relationDetail"
              :resource="selectedResource"
            />
            <DataViewColumnSyncField v-model="columnSync" />
          </section>
          <DataViewWizardColumns
            v-else
            v-show="false"
            v-model:rows="columnRows"
            v-model:loading="columnsLoading"
            v-model:detail="relationDetail"
            :resource="selectedResource"
          />
          <div class="flex flex-col gap-2">
            <pre class="overflow-x-auto rounded-md bg-elevated p-3 font-mono text-xs">{{ JSON.stringify(previewQuery, null, 2) }}</pre>
            <div>
              <UButton
                :label="t(`${W}.showRecords`)"
                icon="i-lucide-table"
                color="neutral"
                variant="outline"
                :disabled="!previewPath"
                @click="previewOpen = true"
              />
            </div>
            <QueryRecordsModal
              v-model:open="previewOpen"
              :title="t(`${W}.recordsTitle`, { name: name || t(`${W}.title`) })"
              :path="previewPath"
              :query="previewQuery"
              :notes="[t(`${W}.previewNote`)]"
            />
          </div>
        </template>
      </div>
    </template>

    <template #settingsLayout>
      <DataViewSettingsLayoutFields
        v-model="settingsLayout"
        :columns="columnRows.map(c => ({ name: c.name, label: c.label }))"
      />
    </template>

    <template #detail>
      <UEmpty
        v-if="detailCandidatesLoading"
        loading
        variant="naked"
        size="sm"
      />
      <UEmpty
        v-else-if="detailItems.length === 0"
        icon="i-lucide-unlink"
        :title="t(`${W}.noRelatedTables`)"
        :description="t(`${W}.noRelatedTablesHelp`, { example: 'invoice_items.invoice' })"
        variant="naked"
      />
      <UFormField
        v-else
        :label="t(`${W}.detailTable`)"
        :description="t(`${W}.detailTableHelp`)"
      >
        <USelectMenu
          v-model="detailChoice"
          :items="detailItems"
          value-key="value"
          class="w-full"
        />
      </UFormField>
    </template>

    <template #detailColumns>
      <i18n-t
        :keypath="`${W}.detailColumnsIntro`"
        tag="p"
        class="text-sm text-muted"
      >
        <template #resource>
          <span class="font-mono">{{ detailResource?.schema }}.{{ detailResource?.name }}</span>
        </template>
      </i18n-t>
      <DataViewWizardColumns
        v-model:rows="detailColumnRows"
        :resource="detailResource"
        :exclude="selectedDetail ? [selectedDetail.fkColumn] : []"
      />
    </template>

    <template #frame>
      <DataViewFrameSettings
        v-model:url="frameUrl"
        v-model:features="features"
      />
    </template>

    <!-- Views: what every view shares, the main view's layout - picked from plain columns - and its own controls. -->
    <template #views>
      <div class="flex flex-col gap-8">
        <LazyDataViewWizardCardStep
          v-if="viewType === 'CARDS'"
          v-model="cardLayout"
          :columns="visibleColumns"
        />
        <LazyDataViewWizardMapStep
          v-else-if="viewType === 'MAP'"
          v-model="mapLayout"
          v-model:view="mapView"
          :columns="visibleColumns"
        />
        <LazyDataViewWizardKanbanStep
          v-else-if="viewType === 'KANBAN'"
          v-model="kanbanLayout"
          :columns="visibleColumns"
        />
        <LazyDataViewWizardGanttStep
          v-else-if="viewType === 'GANTT'"
          v-model="ganttLayout"
          :columns="visibleColumns"
        />
        <LazyDataViewWizardTreeStep
          v-else-if="viewType === 'TREE'"
          v-model="treeLayout"
          v-model:cycle-guard="treeCycleGuard"
          :columns="visibleColumns"
          :all-columns="columnRows"
          :can-guard="selectedResource?.type === 'TABLE' && relationDetail?.canAlter !== false"
        />
        <LazyDataViewWizardCalendarStep
          v-else-if="viewType === 'CALENDAR'"
          v-model="calendarLayout"
          :columns="visibleColumns"
        />
        <DataViewViewSettings
          v-if="viewType && isList"
          v-model:features="features"
          :type="viewType"
        />
        <UCollapsible :default-open="false">
          <UButton
            :label="t(`${W}.moreOptions`)"
            trailing-icon="i-lucide-chevron-down"
            color="neutral"
            variant="link"
          />
          <template #content>
            <div class="pt-4">
              <DataViewPresentationSettings
                v-model:default-density="defaultDensity"
                v-model:default-page-size="defaultPageSize"
                v-model:default-toolbar-mode="defaultToolbarMode"
                v-model:list-margin="listMargin"
                v-model:auto-refresh-preset="autoRefreshPreset"
                v-model:auto-refresh-custom="autoRefreshCustom"
                :paged="viewType === 'TABLE' || viewType === 'CARDS'"
                list
              />
            </div>
          </template>
        </UCollapsible>
      </div>
    </template>

    <template #form>
      <div class="flex flex-col gap-4">
        <DataViewFormSettings
          v-if="viewType"
          v-model:features="features"
          v-model:edit-size="editSize"
          v-model:edit-side="editSide"
          v-model:form-view-mode="formViewMode"
          v-model:master-detail-open-with="masterDetailOpenWith"
          v-model:new-record-label="newRecordLabel"
          v-model:page-content-width="pageContentWidth"
          v-model:page-content-align="pageContentAlign"
          v-model:fit-to-screen="fitToScreen"
          :edit-presentation="editPresentation"
          :dataview="{ viewType, name }"
          :name="name"
          :allow="allow"
          @update:edit-presentation="chooseEditPresentation"
        />
        <UAlert
          v-if="manyColumnsNudge"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t(`${W}.manyColumns`, { count: MANY_FIELDS_THRESHOLD, presentation: presentationLabel(editPresentation) })"
        />
      </div>
    </template>

    <template #actions>
      <DataViewActionsSettings
        v-if="viewType"
        v-model:allow="allow"
        v-model:features="features"
        :view-type="viewType"
        :writable="selectedResource?.type === 'TABLE'"
      />
    </template>

    <template #security>
      <div class="flex flex-col gap-3">
        <p class="text-sm text-muted">
          {{ selectedResource ? t('users.dataviewRoles.descriptionWithSource') : t('users.dataviewRoles.description') }}
        </p>
        <ObjectRolesList
          v-model="roleIds"
          :roles="allRoles ?? []"
        />
      </div>
    </template>
  </WizardModal>
</template>
