<script setup lang="ts">
import { compatibleWidgets, type ColumnPresentation, type WidgetName } from '@totalbase/tb-catalog'
import { TOTAL_KINDS, type TotalKind } from '~/utils/column-totals'
/**
 * Settings' Columns (Specification_DataViews.md §4): what
 * the DataView reads and how its list shows it - one row per column, in
 * real table order: shown or hidden, its title (its table's column's, read
 * only), cell widget, default order and sort; a row opens its panel - a
 * sidebar over the page, as its table column's: Properties, what is the
 * list's (total, truncate, copy), and From the column, its title, format, look and conditions, read
 * only with Edit in the table (Specification_DataViews.md §15) - with Remove
 * from the DataView at its foot; Add columns… / Sync columns. A form's
 * fields (required, disabled, help text) are the Form design's, never set here.
 *
 * Every edit saves at once through `track` - the page's autosave, so its
 * header's status and "flush before leaving" cover these writes too.
 * `default_state` (order, sort) is the page's, shared with its density
 * and page size: read and written through `v-model:default-state`.
 */
import type { TableColumn } from '@nuxt/ui'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import { resolveDefaultState, type DataView, type DataViewField, type SyncFieldsResult } from '~/types/dataview'
import { sortKey } from '~/utils/display-field'
import type { RelationDetail } from '~/types/schema'
import { applicableConfigKeys, type FieldConfig } from '~/utils/field-config'

/** A row of the Columns table: a source column (COLUMN) or a related one (RELATED, no attnum of its own). */
type GridColumnField = DataViewField

const props = defineProps<{
  dataview: DataView
  /** Its COLUMN fields, in real table order. */
  columnFields: (GridColumnField)[]
  /** The source table's catalog - null while it loads. */
  relationDetail: RelationDetail | null
  primaryKey: string | undefined
  /** The page's autosave tracker (useAutosave().track). */
  track: <T>(promise: Promise<T>) => Promise<T>
  /** Reloads the fields and the publish status - after a column is added or removed. */
  refresh: () => Promise<unknown>
  /** Reloads the publish status - after any save. */
  refreshStatus: () => unknown
}>()
/** `view_config.default_state` - order and sort here, density and page size on the page. */
const defaultState = defineModel<Record<string, unknown>>('defaultState', { required: true })

const { t } = useI18n()
const notifyError = useErrorToast()
const api = useAdminApi()
const toast = useToast()

// --- Columns: what this DataView reads and how its grid shows it
// (Specification_DataViews.md §4) - a table of its
// columns, in real table order via columnAttnum: shown or hidden, header,
// cell widget, default order and sort; Add columns… / Remove from the
// DataView. A form's fields (required, disabled, help text) are the Form
// design's, never set here.
//
// Every draft ref below is reset from `columnFields` whenever it changes
// (initial load, or a column added or removed).
const columnVisibility = ref<Record<string, boolean>>({})
const columnWidget = ref<Record<string, string>>({})
/** What the list does with a column (build-dataview-columns.ts reads these from its config) - its look is its table's column's. */
interface ColumnDisplay {
  copyable: boolean
  truncate: boolean
  /** Its total at the grid's foot (Specification_DataViews.md §4.9) - empty: none. */
  total: '' | TotalKind
}
const columnDisplay = ref<Record<string, ColumnDisplay>>({})
let originalDisplay: Record<string, string> = {}
function displayOf(f: DataViewField): ColumnDisplay {
  const config = (f.config ?? {}) as { copyable?: boolean, truncate?: boolean, total?: TotalKind }
  return { copyable: config.copyable === true, truncate: config.truncate === true, total: config.total ?? '' }
}
/** The title a column shows - its table's column's, else its name humanized (Specification_DataViews.md §15). */
function columnTitle(f: DataViewField): string {
  if (f.inherited?.label) return f.inherited.label
  if (f.kind !== 'RELATED') return humanizeColumnName(f.columnName ?? '')
  const [fk = '', column = ''] = (f.columnName ?? '').split('.')
  return `${humanizeColumnName(fk)} · ${humanizeColumnName(column)}`
}
let originalVisibility: Record<string, boolean> = {}
let originalWidget: Record<string, string> = {}
watch(() => props.columnFields, (list) => {
  columnVisibility.value = Object.fromEntries(list.map(f => [f.id, f.visible]))
  columnWidget.value = Object.fromEntries(list.map(f => [f.id, f.widget ?? '']))
  columnDisplay.value = Object.fromEntries(list.map(f => [f.id, displayOf(f)]))
  originalDisplay = Object.fromEntries(Object.entries(columnDisplay.value).map(([id, d]) => [id, JSON.stringify(d)]))
  originalVisibility = { ...columnVisibility.value }
  originalWidget = { ...columnWidget.value }
}, { immediate: true })

/**
 * "Sync columns" (the COLUMNS heading's own toolbar button, template
 * below) - the exact same `POST /dataviews/:id/sync-fields` call
 * `CustomDesigner.vue`'s own `syncFields()` already makes, minus
 * that drawer's own local-array bookkeeping (`localFields.value.push`/
 * `.columnName =`): this page has no separate local copy of `fields` to
 * patch by hand - `columnFields` (just above) is a plain `computed` over
 * the composable's own `fields`, so one `props.refresh()` after the POST
 * is enough for the whole Columns table (and every draft ref its own
 * `watch` derives) to pick up the change on its own. The chat's own
 * motivating case: a column added to the source table AFTER this
 * DataView was created (or last synced) has nothing to bind a formula to
 * until this runs - previously the only way to trigger it was a detour
 * through "Open Design form" for what's otherwise a pure Columns-table
 * concern.
 */
const syncingFields = ref(false)
async function syncFields() {
  syncingFields.value = true
  try {
    const { data } = await api.post<SyncFieldsResult>(`/dataviews/${props.dataview.id}/sync-fields`)
    await Promise.all([props.refresh(), props.refreshStatus()])
    if (data.added.length || data.renamed.length) {
      const parts = [
        data.added.length ? t('designer.dataViewColumnsSettings.sync.added', data.added.length) : null,
        data.renamed.length ? t('designer.dataViewColumnsSettings.sync.renamed', data.renamed.length) : null
      ].filter((p): p is string => p !== null)
      toast.add({ title: t('designer.dataViewColumnsSettings.sync.synced'), description: parts.join(', '), color: 'success' })
    } else {
      toast.add({ title: t('designer.dataViewColumnsSettings.sync.inSync'), description: t('designer.dataViewColumnsSettings.sync.inSyncDescription'), color: 'neutral' })
    }
    if (data.orphaned.length) {
      toast.add({
        title: t('designer.dataViewColumnsSettings.sync.orphaned', data.orphaned.length),
        description: t('designer.dataViewColumnsSettings.sync.orphanedDescription'),
        color: 'warning'
      })
    }
  } catch (err) {
    notifyError(err, t('designer.dataViewColumnsSettings.sync.error'))
  } finally {
    syncingFields.value = false
  }
}

// --- The DataView's columns: what it reads (Specification_DataViews.md §4.1).
// "Add columns…" brings in the table's columns not in it yet;
// a row's "Remove from the DataView" takes one out - it's no longer read.
const addColumnsState = reactive({ open: false, saving: false })
/** Adds the paths picked in the panel - a column of the source, or a related one (`brand.country`). */
async function confirmAddColumns(paths: string[]) {
  if (!props.dataview || !paths.length) return
  addColumnsState.saving = true
  try {
    await props.track(api.post(`/dataviews/${props.dataview.id}/columns`, { data: paths }))
    await Promise.all([props.refresh(), props.refreshStatus()])
    addColumnsState.open = false
  } catch (err) {
    notifyError(err, t('designer.dataViewColumnsSettings.addError'))
  } finally {
    addColumnsState.saving = false
  }
}
/**
 * A related column's roles that won't see it: they open this DataView, but
 * their READ grant on its table lacks its path (`producto.codigo`) - the
 * App leaves it out for them. Asked of the server's Permission Resolver
 * whenever the related columns change; only a warning, never a grant.
 */
const relatedPaths = computed(() => props.columnFields.filter(f => f.kind === 'RELATED' && f.columnName).map(f => f.columnName!).join(','))
const relatedAccess = ref<Record<string, string[]>>({})
const { data: allRoles } = useRoles()
watch(relatedPaths, async (paths) => {
  if (!paths) {
    relatedAccess.value = {}
    return
  }
  try {
    relatedAccess.value = (await api.get<Record<string, string[]>>(`/dataviews/${props.dataview.id}/related-access`)).data
  } catch {
    relatedAccess.value = {}
  }
}, { immediate: true })
function rolesMissing(field: DataViewField): string[] {
  const column = field.columnName
  // A related column's own path; a reference column's, the paths it shows its row by (`cliente.razon_social`) -
  // without them a role sees the key.
  const ids = !column
    ? []
    : field.kind === 'RELATED'
      ? relatedAccess.value[column] ?? []
      : [...new Set(Object.entries(relatedAccess.value).filter(([path]) => path.startsWith(`${column}.`)).flatMap(([, roles]) => roles))]
  return ids.map(id => allRoles.value.find(r => r.id === id)?.name ?? id)
}
/** A reference column's paths some role lacks - what the warning names. */
function missingDisplayPaths(field: DataViewField): string[] {
  const column = field.columnName
  return column && field.kind !== 'RELATED' ? Object.entries(relatedAccess.value).filter(([path, roles]) => path.startsWith(`${column}.`) && roles.length).map(([path]) => path) : []
}

/** The primary key is always in the DataView - editing and deleting a row need it; it can be hidden, not removed (Specification_DataViews.md §4.1). */
function isPrimaryKey(field: DataViewField): boolean {
  return Boolean(field.columnName && props.relationDetail?.primaryKey.includes(field.columnName))
}
async function removeColumn(field: DataViewField) {
  try {
    await props.track(api.del(`/dataviews/${props.dataview.id}/fields/${field.id}`))
    if (panelField.value?.id === field.id) panelOpen.value = false
    await Promise.all([props.refresh(), props.refreshStatus()])
  } catch (err) {
    notifyError(err, t('designer.dataViewColumnsSettings.removeError'))
  }
}

/**
 * Autosave for the Columns table - unlike the rest of this page (one
 * debounced settings PATCH, `saveSettings`), a field-level edit here saves
 * IMMEDIATELY, same as `CustomDesigner.vue`'s own `saveField()`
 * (a PATCH per edit, no Save button there either). The chat's own call:
 * a builder tweaking a label here then clicking "Open Design form"
 * right after needs the designer to see it, not the pre-edit value it'd
 * get from a draft this page hasn't sent yet - `openDesignForm()` below
 * waits for every tracked save (this one included) before navigating.
 *
 * Deliberately does NOT write the server's response back into
 * `fields.value` - that would recompute `columnFields` (a NEW array
 * reference every time `fields.value` changes) and re-fire the
 * `immediate` reset `watch` right above, wiping whatever a builder is
 * mid-typing in every OTHER row's Label/Help right as this one row's
 * save lands. `original*` is updated locally instead, straight from
 * what was just sent - correct as long as this page is the only writer
 * (true for a single builder's own session; a concurrent edit from
 * another tab/person is the same "last write wins" tradeoff the rest of
 * this page's own settings autosave already accepts).
 */
async function saveFieldPatch(fieldId: string, payload: Record<string, unknown>) {
  try {
    await props.track(api.patch(`/dataviews/${props.dataview.id}/fields/${fieldId}`, { data: payload }))
    props.refreshStatus()
  } catch (err) {
    notifyError(err, t('designer.dataViewColumnsSettings.saveError'))
  }
}
/** Visible/Widget are discrete choices (a click/select) - saved right away, no debounce. */
watch(columnVisibility, (val) => {
  for (const id of Object.keys(val)) {
    if (val[id] === originalVisibility[id]) continue
    originalVisibility[id] = val[id]!
    saveFieldPatch(id, { visible: val[id] })
  }
}, { deep: true })
watch(columnWidget, (val) => {
  for (const id of Object.keys(val)) {
    if (val[id] === originalWidget[id]) continue
    originalWidget[id] = val[id]!
    saveFieldPatch(id, { widget: val[id] || undefined })
  }
}, { deep: true })
/**
 * A column's display options land in the field's `config`, which the server REPLACES
 * wholesale (dataviews-admin-service.ts's `updateField`) - the save is
 * built from the field's current config, debounced per field.
 */
const configSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleFieldConfigSave(fieldId: string) {
  clearTimeout(configSaveTimers.get(fieldId))
  configSaveTimers.set(fieldId, setTimeout(() => {
    configSaveTimers.delete(fieldId)
    const field = props.columnFields.find(f => f.id === fieldId)
    if (!field) return
    const nextConfig: Record<string, unknown> = { ...(field.config as FieldConfig | undefined ?? {}) }
    const display = columnDisplay.value[fieldId]
    if (display) {
      const set = (key: string, value: unknown) => {
        if (value === undefined || value === '' || value === false) Reflect.deleteProperty(nextConfig, key)
        else nextConfig[key] = value
      }
      set('copyable', display.copyable)
      set('truncate', display.truncate)
      set('total', display.total)
      originalDisplay[fieldId] = JSON.stringify(display)
    }
    // What its foreign key shows is its table's (read with the field, never stored).
    for (const key of ['display_field', 'display_template', 'display_field_target', 'display_inherited']) Reflect.deleteProperty(nextConfig, key)
    saveFieldPatch(fieldId, { config: nextConfig })
  }, 500))
}
watch(columnDisplay, (display) => {
  for (const [id, d] of Object.entries(display)) {
    if (JSON.stringify(d) !== originalDisplay[id]) scheduleFieldConfigSave(id)
  }
}, { deep: true })

/** What a column's panel offers - what its widget and type can show (applicableConfigKeys), a FORM's search. */
function columnOptions(field: GridColumnField) {
  const keys = applicableConfigKeys(columnWidget.value[field.id] || field.widget || '', Boolean(foreignKeyFor(field)))
  const kind = (field.config as { displayFormatKind?: 'number' | 'date' | 'time' | 'datetime' } | undefined)?.displayFormatKind ?? null
  return {
    // A number or a date has its format instead - a truncation is for text.
    truncate: !kind && keys.has('truncate'),
    copyable: keys.has('copyable'),
    // A number adds up; any column counts its values - a list's, not a FORM's.
    totals: props.dataview.viewType === 'FORM' ? [] : kind === 'number' ? [...TOTAL_KINDS] : ['count'] as TotalKind[]
  }
}
/** The tables the source's foreign keys point at. */
const { resources: resourceList } = useResourcesList()

function dataTypeFor(f: GridColumnField): string {
  return (props.relationDetail?.columns ?? []).find(c => c.attnum === f.columnAttnum)?.dataType ?? ''
}
function foreignKeyFor(f: GridColumnField) {
  return f.kind === 'COLUMN' ? props.relationDetail?.relations.find(r => r.sourceColumn === f.columnName) ?? null : null
}
/** Same `compatibleWidgets()` the Design form's own picker already filters by - the current value is always kept in the list even if it falls outside that set (a widget picked before the column's type changed, say), so the select never shows blank for an already-saved value. */
function widgetOptionsFor(f: GridColumnField): WidgetName[] {
  const compatible = compatibleWidgets(dataTypeFor(f), foreignKeyFor(f))
  const current = columnWidget.value[f.id] as WidgetName | undefined
  return current && !compatible.includes(current) ? [current, ...compatible] : compatible
}

// --- Group 2: default column order - which order a first-time viewer
// (or anyone who never personally customized anything) sees the
// columns in, `view_config.default_state.columnPrefs[col].order`
// (types/dataview.ts's `resolveDefaultState`). Lives HERE (Move up/
// down per row) - the one place the author sets it, as `sortEntries`
// below; the density's is Settings › Presentation's.
//
// `columnOrder` is this table's own row order, as an array of field
// ids - initialized from `currentDefaultState.columnPrefs`'s `order`
// numbers when at least one is set, falling back to columnAttnum (raw
// DB order, `columnFields`'s own default) otherwise. Re-derived
// whenever `columnFields` OR `currentDefaultState` change (a real
// reload - `defaultState.value` is never mutated mid-session by
// anything else on this page, every other draft here tracks its own
// value/original pair instead), never while a builder is mid-drag -
// there's no drag here, just two buttons, but the same "don't clobber
// an in-progress edit" discipline every other draft ref on this page
// already follows.
/**
 * Shared write path for BOTH `columnOrder` and `sortEntries` below -
 * same immediate save as `saveFieldPatch` above, and
 * same reason: order/sort need to already be on the server by the time
 * a builder opens the Design form or the live grid, not stuck in an
 * unsaved draft. `mutate` gets the CURRENTLY stored `default_state`
 * (spread, never replaced wholesale - same shallow-merge discipline the
 * settings autosave below uses for density/pageSize) to add/remove
 * just its own key; `defaultState.value` is updated locally on
 * success so a LATER write here (or `saveSettings`'s own density/pageSize
 * write) always spreads the latest state, never a stale snapshot from
 * before this one landed.
 */
async function patchDefaultState(mutate: (next: Record<string, unknown>) => void) {
  const next: Record<string, unknown> = { ...defaultState.value }
  mutate(next)
  try {
    await props.track(api.patch(`/dataviews/${props.dataview.id}`, { data: { viewConfig: { default_state: next } } }))
    defaultState.value = next
    props.refreshStatus()
  } catch (err) {
    notifyError(err, t('designer.dataViewColumnsSettings.saveOrderError'))
  }
}

const columnOrder = ref<string[]>([])
let originalColumnOrder: string[] = []
const CENTER = { class: { th: 'w-16 text-center', td: 'w-16 text-center' } }
const COLUMN_TABLE_COLUMNS = computed<TableColumn<GridColumnField>[]>(() => [
  { id: 'move', header: '', meta: { class: { th: 'w-12', td: 'w-12' } } },
  { id: 'visible', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  // Its title - its table's column's, read only - with the column's own name under it.
  // Its header reads like its cells: the title, the column's name under it.
  {
    id: 'label',
    header: () => h('div', [h('span', t('common.label')), h('span', { class: 'block font-mono text-xs font-normal text-muted' }, t('designer.dataViewColumnsSettings.columnName'))]),
    meta: { class: { th: 'w-48 min-w-40', td: 'w-48 min-w-40' } }
  },
  { id: 'widget', header: t('designer.dataViewColumnsSettings.widget'), meta: { class: { th: 'w-40', td: 'w-40' } } },
  { id: 'sort', header: t('designer.dataViewColumnsSettings.sort'), meta: CENTER },
  // Its panel - also a click on the row.
  { id: 'settings', header: '', meta: { class: { th: 'w-12', td: 'w-12' } } }
])
const orderedColumnFields = computed(() => {
  const byId = new Map(props.columnFields.map(f => [f.id, f]))
  const ordered: (GridColumnField)[] = []
  for (const id of columnOrder.value) {
    const f = byId.get(id)
    if (f) ordered.push(f)
  }
  return ordered
})
watch([() => props.columnFields, defaultState], ([list, state]) => {
  const prefs = (state.columnPrefs ?? {}) as Record<string, { order?: number }>
  const hasStoredOrder = Object.values(prefs).some(p => typeof p.order === 'number')
  const sorted = [...list]
  if (hasStoredOrder) {
    sorted.sort((a, b) => (prefs[a.columnName!]?.order ?? Number.MAX_SAFE_INTEGER) - (prefs[b.columnName!]?.order ?? Number.MAX_SAFE_INTEGER))
  }
  columnOrder.value = sorted.map(f => f.id)
  originalColumnOrder = [...columnOrder.value]
}, { immediate: true })
/** Swaps row `index` with its neighbor - no drag-and-drop library, just two buttons. */
function moveColumn(index: number, direction: -1 | 1) {
  const next = index + direction
  if (next < 0 || next >= columnOrder.value.length) return
  const copy = [...columnOrder.value]
  const tmp = copy[index]!
  copy[index] = copy[next]!
  copy[next] = tmp
  columnOrder.value = copy
}
/** Debounced (400ms) so a few quick clicks coalesce into one write instead of several overlapping ones that could land out of order on the wire. */
let columnOrderSaveTimer: ReturnType<typeof setTimeout> | undefined
watch(columnOrder, (val) => {
  const changed = val.length !== originalColumnOrder.length || val.some((id, i) => id !== originalColumnOrder[i])
  if (!changed) return
  originalColumnOrder = [...val]
  if (columnOrderSaveTimer !== undefined) clearTimeout(columnOrderSaveTimer)
  columnOrderSaveTimer = setTimeout(() => {
    columnOrderSaveTimer = undefined
    patchDefaultState((next) => {
      const prevPrefs = (next.columnPrefs ?? {}) as Record<string, { visible?: boolean, order?: number }>
      const nextPrefs: Record<string, { visible?: boolean, order?: number }> = { ...prevPrefs }
      columnOrder.value.forEach((id, index) => {
        const colName = props.columnFields.find(f => f.id === id)?.columnName
        if (!colName) return
        nextPrefs[colName] = { ...(prevPrefs[colName] ?? {}), order: index }
      })
      next.columnPrefs = nextPrefs
    })
  }, 400)
})

// --- Group 2: default sort - which column(s) a first-time viewer (or
// anyone who never personally customized anything) sees the rows
// ordered by, `view_config.default_state.sort` (types/dataview.ts's
// `resolveDefaultState`). Lives HERE (one control per row, a click
// cycles none -> asc -> desc -> none, with a small priority badge once
// more than one column is picked) rather than as a separate standalone
// control (an earlier round of this page had one, single-column, under
// Features): one place to reason about column
// order, not two that can drift apart. The wire format was already
// multi-column capable (`packages/query-engine/parser.ts`'s own
// `order_by=col1,-col2` comma-split) even though the interactive
// per-viewer grid sort (clicking a column header) stays single-column,
// a separate and much older piece of UX this table doesn't touch.
interface SortEntry { column: string, direction: 'asc' | 'desc' }
const sortEntries = ref<SortEntry[]>([])
let originalSortString = ''
const defaultSortString = computed(() => sortEntries.value.map(e => e.direction === 'desc' ? `-${e.column}` : e.column).join(','))
function sortStateFor(columnName: string): { direction: 'asc' | 'desc', priority: number } | null {
  const idx = sortEntries.value.findIndex(e => e.column === columnName)
  return idx === -1 ? null : { direction: sortEntries.value[idx]!.direction, priority: idx + 1 }
}
/** none -> asc -> desc -> none, appended at the end when newly added - same as clicking a grid column header repeatedly, just kept across more than one column here. */
function cycleSort(columnName: string) {
  const idx = sortEntries.value.findIndex(e => e.column === columnName)
  if (idx === -1) sortEntries.value = [...sortEntries.value, { column: columnName, direction: 'asc' }]
  else if (sortEntries.value[idx]!.direction === 'asc') sortEntries.value = sortEntries.value.map((e, i) => i === idx ? { ...e, direction: 'desc' as const } : e)
  else sortEntries.value = sortEntries.value.filter((_, i) => i !== idx)
}
/** The sort button's tooltip and accessible name: the current default sort, and what a click does next (cycleSort's order). */
function sortHint(columnName: string): string {
  const state = sortStateFor(columnName)
  if (!state) return t('designer.dataViewColumnsSettings.sortHint.none')
  const priority = sortEntries.value.length > 1 ? t('designer.dataViewColumnsSettings.sortHint.priority', { priority: state.priority }) : ''
  return state.direction === 'asc'
    ? t('designer.dataViewColumnsSettings.sortHint.asc', { priority })
    : t('designer.dataViewColumnsSettings.sortHint.desc', { priority })
}
/** What its panel's Properties set on this row - the button shows it, so nothing set there goes unseen. */
function hasColumnSettings(field: GridColumnField): boolean {
  const d = columnDisplay.value[field.id]
  return Boolean(d && (d.copyable || d.truncate || d.total))
}
/** Same debounced autosave as `columnOrder` above, through the same `patchDefaultState`. */
let sortSaveTimer: ReturnType<typeof setTimeout> | undefined
watch(sortEntries, () => {
  if (defaultSortString.value === originalSortString) return
  originalSortString = defaultSortString.value
  if (sortSaveTimer !== undefined) clearTimeout(sortSaveTimer)
  sortSaveTimer = setTimeout(() => {
    sortSaveTimer = undefined
    patchDefaultState((next) => {
      if (defaultSortString.value) next.sort = defaultSortString.value
      else delete next.sort
    })
  }, 400)
}, { deep: true })

// The default sort, as stored - seeded per DataView (and on a reload), not
// on every default_state write, so a pending sort edit is never reset by an
// order save landing first.
watch(() => props.dataview, () => {
  const storedSort = resolveDefaultState(props.dataview.viewConfig).sort
  if (typeof storedSort === 'string' && storedSort) {
    originalSortString = storedSort
    sortEntries.value = storedSort.split(',').filter(Boolean).map((entry) => {
      const desc = entry.startsWith('-')
      return { column: desc ? entry.slice(1) : entry, direction: desc ? 'desc' as const : 'asc' as const }
    })
  } else {
    // Shown as the implied default (the runtime orders by the primary key
    // too), not an edit - saving it would dirty the draft just by opening.
    sortEntries.value = props.primaryKey ? [{ column: props.primaryKey, direction: 'asc' }] : []
    originalSortString = defaultSortString.value
  }
}, { immediate: true })

// --- A column's panel (Specification_DataViews.md §4, §15): beside a sidebar over the page, as its table column's - Properties, the list's;
// From the column, its table's column's presentation, read only.
const panelField = ref<GridColumnField | null>(null)
const panelOpen = ref(false)
const panelTab = ref<'properties' | 'column'>('properties')
const PANEL_TABS = computed(() => [
  { label: t('designer.dataViewColumnsSettings.panel.properties'), value: 'properties' },
  { label: t('designer.dataViewColumnsSettings.panel.fromColumn'), value: 'column' }
])
function openPanel(field: GridColumnField) {
  panelField.value = field
  panelOpen.value = true
}
// A reload hands new field objects - the panel follows its column, or closes when it's gone.
watch(() => props.columnFields, (list) => {
  if (!panelField.value) return
  const next = list.find(f => f.id === panelField.value!.id)
  if (next) panelField.value = next
  else panelOpen.value = false
})
const panelIndex = computed(() => orderedColumnFields.value.findIndex(f => f.id === panelField.value?.id))
/** The column it shows - its source's, or a related column's in the table its foreign key points at. */
const panelColumn = computed<{ resourceId: string, column: string } | null>(() => {
  const field = panelField.value
  if (!field?.columnName) return null
  if (field.kind !== 'RELATED') return props.dataview.sourceResource ? { resourceId: props.dataview.sourceResource, column: field.columnName } : null
  const [fk, column] = field.columnName.split('.')
  const relation = props.relationDetail?.relations.find(r => r.sourceColumn === fk)
  const target = relation ? resourceList.value.find(r => r.schema === relation.targetSchema && r.name === relation.targetTable) : undefined
  return target && column ? { resourceId: target.id, column } : null
})
/** A foreign key: what it shows of the row it points at - its table's row presentation (§15.5). */
const panelShows = computed(() => {
  const config = (panelField.value?.config ?? {}) as { display_template?: string, display_field?: string }
  return foreignKeyFor(panelField.value!) ? config.display_template ?? config.display_field ?? '' : ''
})
</script>

<template>
  <!-- Columns: what this DataView reads and how its grid shows it
  (Specification_DataViews.md §4) - order,
  shown or hidden, header, cell widget, default sort; Add
  columns… and Remove from the DataView. A form's fields -
  required, disabled, help text - are the Form design's. -->
  <SettingsSection :title="t('designer.dataViewColumnsSettings.heading')">
    <template #actions>
      <!-- "Sync columns" - reconciles this table against the
      source's REAL, current Postgres columns (new/renamed/
      removed) without a detour through "Design form" for
      what's otherwise a pure Columns-table concern - this
      section's own `syncFields()` doc comment. -->
      <div class="flex items-center gap-2">
        <UButton
          :label="t('designer.dataViewColumnsSettings.addColumns')"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="!relationDetail"
          @click="addColumnsState.open = true"
        />
        <UTooltip :text="t('designer.dataViewColumnsSettings.syncTooltip')">
          <UButton
            icon="i-lucide-refresh-cw"
            :aria-label="t('designer.dataViewColumnsSettings.syncColumns')"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="syncingFields"
            @click="syncFields"
          />
        </UTooltip>
      </div>
    </template>
    <p class="text-xs text-muted">
      {{ t('designer.dataViewColumnsSettings.intro') }}
    </p>
    <p class="text-xs text-muted">
      {{ t('designer.dataViewColumnsSettings.notSecurity') }}
    </p>
    <UTable
      v-if="columnFields.length > 0"
      sticky
      :meta="{ class: { tr: (row: { original: DataViewField }) => (columnVisibility[row.original.id] ? '' : 'opacity-50') } }"
      :data="orderedColumnFields"
      :columns="COLUMN_TABLE_COLUMNS"
    >
      <template #move-cell="{ row: { index } }">
        <div class="flex flex-col leading-none">
          <UButton
            icon="i-lucide-chevron-up"
            color="neutral"
            variant="ghost"
            size="xs"
            class="h-4 w-4 p-0"
            :disabled="index === 0"
            :aria-label="t('designer.dataViewColumnsSettings.moveUp')"
            @click="moveColumn(index, -1)"
          />
          <UButton
            icon="i-lucide-chevron-down"
            color="neutral"
            variant="ghost"
            size="xs"
            class="h-4 w-4 p-0"
            :disabled="index === orderedColumnFields.length - 1"
            :aria-label="t('designer.dataViewColumnsSettings.moveDown')"
            @click="moveColumn(index, 1)"
          />
        </div>
      </template>
      <template #visible-cell="{ row: { original: field } }">
        <UCheckbox
          v-model="columnVisibility[field.id]"
          :aria-label="field.columnName ?? field.label ? t('designer.dataViewColumnsSettings.showColumn', { name: field.columnName ?? field.label }) : t('designer.dataViewColumnsSettings.showColumnUnnamed')"
        />
      </template>
      <template #label-cell="{ row: { original: field } }">
        <!-- Its title opens its panel, as its panel button does. -->
        <button
          type="button"
          class="block w-full min-w-0 text-left"
          @click="openPanel(field)"
        >
          <span class="block truncate text-sm text-highlighted">
            {{ columnTitle(field) }}
          </span>
          <span class="mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted">
            <UTooltip
              v-if="isPrimaryKey(field)"
              :text="t('designer.dataViewColumnsSettings.primaryKeyTooltip')"
            >
              <UIcon
                name="i-lucide-key-round"
                class="size-3 shrink-0"
              />
            </UTooltip>
            {{ field.columnName }}
            <UTooltip
              v-if="rolesMissing(field).length"
              :text="field.kind === 'RELATED'
                ? t('designer.dataViewColumnsSettings.notSeenBy', { roles: rolesMissing(field).join(', '), column: field.columnName })
                : t('designer.dataViewColumnsSettings.keyOnlyFor', { roles: rolesMissing(field).join(', '), paths: missingDisplayPaths(field).join(', ') })"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-3 shrink-0 text-warning"
              />
            </UTooltip>
          </span>
        </button>
      </template>
      <template #widget-cell="{ row: { original: field } }">
        <!-- A related column is shown as its type says - read only, nothing to pick. -->
        <UTooltip
          v-if="field.kind === 'RELATED'"
          :text="t('designer.dataViewColumnsSettings.relatedTooltip')"
        >
          <UBadge
            :label="t('designer.dataViewColumnsSettings.related')"
            icon="i-lucide-link-2"
            color="neutral"
            variant="subtle"
          />
        </UTooltip>
        <USelectMenu
          v-else
          v-model="columnWidget[field.id]"
          :aria-label="t('designer.dataViewColumnsSettings.widget')"
          :items="(widgetOptionsFor(field) as string[])"
          size="sm"
          class="w-full"
        />
      </template>
      <template #sort-cell="{ row: { original: field } }">
        <div class="flex justify-center">
          <SortOrderButton
            v-if="field.columnName"
            :direction="sortStateFor(sortKey(field))?.direction ?? null"
            :priority="sortEntries.length > 1 ? sortStateFor(sortKey(field))?.priority : undefined"
            :hint="sortHint(sortKey(field))"
            @click="cycleSort(sortKey(field))"
          />
        </div>
      </template>
      <template #settings-cell="{ row: { original: field } }">
        <!-- Edit (its panel) and Remove, in the row - a column leaves the DataView from here, not from inside its panel. -->
        <div class="flex items-center justify-center gap-1">
          <UTooltip :text="t('designer.dataViewColumnsSettings.settingsOf', { name: field.columnName })">
            <UButton
              icon="i-lucide-pencil"
              :color="panelOpen && panelField?.id === field.id ? 'primary' : hasColumnSettings(field) ? 'primary' : 'neutral'"
              :variant="panelOpen && panelField?.id === field.id ? 'solid' : hasColumnSettings(field) ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('designer.dataViewColumnsSettings.settingsOf', { name: field.columnName })"
              :aria-pressed="panelOpen && panelField?.id === field.id"
              @click="openPanel(field)"
            />
          </UTooltip>
          <!-- A small, anchored confirmation (AGENTS.md §25); the primary key can't go - it says why. -->
          <UPopover v-if="!isPrimaryKey(field)">
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :aria-label="t('designer.dataViewColumnsSettings.removeOf', { name: field.columnName })"
            />
            <template #content="{ close }">
              <div class="flex w-64 flex-col gap-2 p-3">
                <p class="text-sm font-medium">
                  {{ t('designer.dataViewColumnsSettings.removeOf', { name: field.columnName }) }}
                </p>
                <p class="text-xs text-muted">
                  {{ t('designer.dataViewColumnsSettings.removeHelp') }}
                </p>
                <div class="flex justify-end gap-2 pt-1">
                  <UButton
                    :label="t('common.cancel')"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="close()"
                  />
                  <UButton
                    :label="t('designer.dataViewColumnsSettings.remove')"
                    size="xs"
                    color="error"
                    @click="close(); removeColumn(field)"
                  />
                </div>
              </div>
            </template>
          </UPopover>
          <UTooltip
            v-else
            :text="t('designer.dataViewColumnsSettings.removePrimaryKey')"
          >
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              disabled
              :aria-label="t('designer.dataViewColumnsSettings.removePrimaryKey')"
            />
          </UTooltip>
        </div>
      </template>
    </UTable>
    <p
      v-else
      class="text-xs text-muted"
    >
      {{ t('designer.dataViewColumnsSettings.empty') }}
    </p>
    <!-- A column's panel, a sidebar over the page as its table column's: Properties (the list's), From the column (its table's, read only). -->
    <USlideover
      v-if="panelField"
      v-model:open="panelOpen"
      :title="columnTitle(panelField)"
      :description="panelField.columnName ?? undefined"
      :ui="{ content: 'max-w-xl' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UTabs
            v-model="panelTab"
            :items="PANEL_TABS"
            :content="false"
            size="xs"
          />
          <template v-if="panelTab === 'properties'">
            <UFormField :label="t('designer.dataViewColumnsSettings.panel.visible')">
              <USwitch v-model="columnVisibility[panelField.id]" />
            </UFormField>
            <UFormField :label="t('designer.dataViewColumnsSettings.panel.order')">
              <div class="flex gap-1">
                <UButton
                  icon="i-lucide-chevron-up"
                  :label="t('designer.dataViewColumnsSettings.moveUp')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="panelIndex <= 0"
                  @click="moveColumn(panelIndex, -1)"
                />
                <UButton
                  icon="i-lucide-chevron-down"
                  :label="t('designer.dataViewColumnsSettings.moveDown')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="panelIndex < 0 || panelIndex === orderedColumnFields.length - 1"
                  @click="moveColumn(panelIndex, 1)"
                />
              </div>
            </UFormField>
            <UFormField
              v-if="panelField.kind !== 'RELATED'"
              :label="t('designer.dataViewColumnsSettings.widget')"
            >
              <USelectMenu
                v-model="columnWidget[panelField.id]"
                :items="(widgetOptionsFor(panelField) as string[])"
                class="w-full"
              />
            </UFormField>
            <UFormField
              v-if="columnOptions(panelField).totals.length"
              :label="t('designer.dataViewColumnsSettings.total')"
              :description="t('designer.dataViewColumnsSettings.totalDescription')"
            >
              <USelect
                :model-value="columnDisplay[panelField.id]!.total || 'none'"
                :items="[{ label: t('common.none'), value: 'none' }, ...columnOptions(panelField).totals.map(k => ({ label: t(`designer.dataViewColumnsSettings.totals.${k}`), value: k }))]"
                class="w-full"
                :aria-label="t('designer.dataViewColumnsSettings.totalOf', { name: panelField.columnName })"
                @update:model-value="(v: string) => { columnDisplay[panelField!.id]!.total = v === 'none' ? '' : v as TotalKind }"
              />
            </UFormField>
            <UFormField
              v-if="columnOptions(panelField).truncate"
              :label="t('designer.dataViewColumnsSettings.truncate')"
              :description="t('designer.dataViewColumnsSettings.truncateDescription')"
            >
              <USwitch v-model="columnDisplay[panelField.id]!.truncate" />
            </UFormField>
            <UFormField
              v-if="columnOptions(panelField).copyable"
              :label="t('designer.dataViewColumnsSettings.copyButton')"
              :description="t('designer.dataViewColumnsSettings.copyButtonDescription')"
            >
              <USwitch v-model="columnDisplay[panelField.id]!.copyable" />
            </UFormField>
          </template>
          <ColumnPresentationSummary
            v-else-if="panelColumn"
            :key="`${panelColumn.resourceId}.${panelColumn.column}`"
            :resource-id="panelColumn.resourceId"
            :column-name="panelColumn.column"
            :presentation="(panelField.inherited ?? {}) as ColumnPresentation"
            :shows="panelShows"
            @saved="refresh()"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex flex-col gap-1">
          <div>
            <UButton
              :label="t('designer.dataViewColumnsSettings.remove')"
              icon="i-lucide-minus-circle"
              color="error"
              variant="ghost"
              :disabled="isPrimaryKey(panelField)"
              @click="removeColumn(panelField)"
            />
          </div>
          <p class="text-xs text-muted">
            {{ isPrimaryKey(panelField) ? t('designer.dataViewColumnsSettings.removePrimaryKey') : t('designer.dataViewColumnsSettings.removeHelp') }}
          </p>
        </div>
      </template>
    </USlideover>
    <DataViewAddColumnsPanel
      v-model:open="addColumnsState.open"
      :dataview="dataview"
      :column-fields="columnFields"
      :relation-detail="relationDetail"
      :saving="addColumnsState.saving"
      @add="confirmAddColumns"
    />
  </SettingsSection>
</template>
