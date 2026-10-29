import type { ActionTarget } from '~/utils/custom-actions'
import { DEFAULT_ROLE_COLOR, type RoleColor } from '~/types/permission'
import { looksLikeSettingsTable, REQUIRED_SETTINGS_LAYOUT_KEYS, SETTINGS_LAYOUT_KEYS, suggestSettingsLayout, type ColumnPresentation, type CellAlign, type GridCellTextWrap, type SettingsLayout } from '@totalbase/tb-catalog'

/** Shape of `totalbase.dataviews` rows as returned by the Admin API — DataViews.md. */
export type DataViewType = 'TABLE' | 'FORM' | 'CARDS' | 'MAP' | 'KANBAN' | 'CALENDAR' | 'GANTT' | 'TREE' | 'EXTERNALFRAME' | 'MASTER_DETAIL' | 'CUSTOM' | 'SETTINGS'
export type DataViewScope = 'LISTED' | 'EMBEDDED_ONLY'

/** Every layout, in the wizard's order. */
export const DATAVIEW_TYPES: DataViewType[] = ['TABLE', 'FORM', 'CARDS', 'MAP', 'KANBAN', 'CALENDAR', 'GANTT', 'TREE', 'EXTERNALFRAME', 'MASTER_DETAIL', 'CUSTOM', 'SETTINGS']
/** Record-form layouts - the DataView IS one record's form (DataViewRecordPage.vue), laid out in the Design form, opened as a page. */
export const FORM_LIKE_DATAVIEW_TYPES: DataViewType[] = ['FORM', 'MASTER_DETAIL']
/** Layouts with no source table or view - their own design, no columns. */
export const SOURCELESS_DATAVIEW_TYPES: DataViewType[] = ['EXTERNALFRAME', 'CUSTOM']
/** Layouts another DataView can link to (a Detail widget) - every one with a data source (the server's own `resolveLinkTarget` rule). */
export const LINKABLE_DATAVIEW_TYPES: DataViewType[] = DATAVIEW_TYPES.filter(type => !SOURCELESS_DATAVIEW_TYPES.includes(type))

/**
 * The catalogs below keep their English as written; the UI translates them
 * (Admin_UI.md §14) through keys derived from the catalog key,
 * the English as the fallback (`useCatalogText()`):
 * `dataviews.meta.<catalog>.<key>.label|description` - catalogs `types`,
 * `formViewModes`, `openWith`, `editPresentations`, `editSizes`, `editSides`,
 * `pageContentAligns`, `pageContentWidths`, `columnSync`, `densities`;
 * `dataviews.meta.autoRefresh.<value>` (Off, Custom…),
 * `dataviews.meta.designerViews.<value>`, `dataviews.meta.notices.columnSync|baseWhere`,
 * and a feature's `featureLabelKey()`/`featureDescriptionKey()`.
 */
export function dataviewMetaKey(catalog: string, key: string, part: 'label' | 'description'): string {
  return `dataviews.meta.${catalog}.${key}.${part}`
}
/** A feature's label - the same for every type. */
export function featureLabelKey(feature: Pick<DataViewFeatureMeta, 'key'>): string {
  return `dataviews.meta.featureLabels.${feature.key}`
}
/** A feature's description - per type, as the English differs ("above the map", "above the board"). */
export function featureDescriptionKey(type: DataViewType, feature: Pick<DataViewFeatureMeta, 'key'>): string {
  return `dataviews.meta.featureDescriptions.${type}.${feature.key}`
}

/**
 * The wizard's Type step (step 1) - one card per layout, icon + title +
 * one-line description.
 */
export const DATAVIEW_TYPE_META: Record<DataViewType, { label: string, icon: string, description: string }> = {
  TABLE: { label: 'Table', icon: 'i-lucide-table', description: 'A sortable, searchable grid over the rows.' },
  FORM: { label: 'Form', icon: 'i-lucide-square-pen', description: 'One record at a time, laid out as a form.' },
  CARDS: { label: 'Cards', icon: 'i-lucide-layout-grid', description: 'Rows as a grid of cards - good for images or summaries.' },
  MAP: { label: 'Map', icon: 'i-lucide-map', description: 'Rows plotted on a map, from a location column.' },
  KANBAN: { label: 'Kanban', icon: 'i-lucide-columns-3', description: 'Rows grouped into columns by a status field.' },
  CALENDAR: { label: 'Calendar', icon: 'i-lucide-calendar-days', description: 'Rows placed on a calendar by a date column.' },
  GANTT: { label: 'Gantt', icon: 'i-lucide-gantt-chart-square', description: 'Rows as timeline bars, from start/end date columns.' },
  TREE: { label: 'Tree', icon: 'i-lucide-list-tree', description: 'A hierarchy - rows under their parent row, as a tree or an org chart.' },
  EXTERNALFRAME: { label: 'External frame', icon: 'i-lucide-app-window', description: 'Embed an external page or app - no data source.' },
  MASTER_DETAIL: { label: 'Master-detail', icon: 'i-lucide-receipt-text', description: 'A new record with its detail rows - an order and its items.' },
  CUSTOM: { label: 'Custom', icon: 'i-lucide-layout-panel-left', description: 'A blank page: place any widget, bind it to variables, wire it with code.' },
  SETTINGS: { label: 'Settings', icon: 'i-lucide-sliders-horizontal', description: 'A parameter table - one row per setting (key, value, title, description), edited in place like TotalBase\'s own Settings.' }
}

/**
 * Per-type toggleable grid features (wizard step 5) - only TABLE has a
 * catalog so far since it's the only implemented layout; each later type
 * gets its own list once it ships (a Kanban board has no "print", a Form
 * has no "columns", etc. - deliberately not one shared list for all).
 *
 * `group` splits the catalog in two for the wizard/Edit DataView UI:
 * `'table'` is the grid itself (DataViewGrid.vue's own toolbar - search,
 * filter, the table-wide History button, etc.), `'form'` is the record
 * edit/create form (the record form's frame (DataViewRecordPanel.vue), all four edit-presentations) -
 * two clearly separate surfaces a DataView owner reasons about
 * independently, not one flat list mixing "hide the grid's Export
 * button" with "hide a record's Clone button".
 */
export interface DataViewFeatureMeta {
  key: string
  label: string
  description: string
  default: boolean
  group: 'table' | 'form' | 'frame'
}
/**
 * The `group: 'form'` catalog - the record form's frame (DataViewRecordPanel.vue)'s own actions
 * (Clone/Save & New/Copy/Print/History/Prev-Next). Shared by TABLE (its
 * record edit/create form, any EditPresentation) and FORM (the DataView
 * IS this form - DataViewRecordPage.vue) rather than duplicated, since both
 * render through the exact same record form frame.
 */
const RECORD_FORM_FEATURES: DataViewFeatureMeta[] = [
  { key: 'recordClone', label: 'Clone', description: 'Clone the record being edited into a new draft.', default: true, group: 'form' },
  { key: 'recordSaveAndNew', label: 'Save & New', description: 'Save the record, then reset the form for another one.', default: true, group: 'form' },
  { key: 'recordCopy', label: 'Copy', description: 'Copy the record\'s values as text - "Field: value", one per line.', default: true, group: 'form' },
  { key: 'recordPrint', label: 'Print', description: 'Print-friendly view of the single record being edited.', default: true, group: 'form' },
  { key: 'recordHistory', label: 'Activity', description: 'A record\'s Activity - who created and changed it, and what.', default: true, group: 'form' },
  { key: 'recordNavigation', label: 'Previous/Next', description: 'A FORM only: step to the previous/next record without leaving it.', default: true, group: 'form' }
]
export const TABLE_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the grid.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/columns/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'density', label: 'Density', description: 'Row density switcher (comfortable/compact/etc).', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'columnsToggle', label: 'Columns', description: 'Let viewers show/hide and reorder columns.', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'print', label: 'Print', description: 'Print-friendly view of the grid.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the grid.', default: true, group: 'table' },
  { key: 'rowEdit', label: 'Row edit', description: 'Click anywhere on a row to open its edit form - the row highlights on hover with a pointer cursor.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * FORM's own catalog (wizard step 5 / "Edit DataView") - `search` gates
 * the "Search" button + `RecordSearchSidebar.vue` (meaningless in READ
 * mode's `formViewMode === 'CREATE'`, where that button never renders
 * regardless - see `resolveFormViewMode`'s own doc comment), plus the
 * same record-form actions TABLE's own edit form already offers. No
 * `group: 'table'` entries here at all - FORM has no grid of its own.
 */
/** FORM/MASTER_DETAIL's own Save and Cancel - off when the page saves through its own buttons (a workflow button that saves first, a Record action). */
const SAVE_CANCEL_FEATURE: DataViewFeatureMeta = { key: 'recordSaveCancel', label: 'Save and Cancel', description: 'The form\'s own Save and Cancel buttons - turn off when the page saves through its own buttons.', default: true, group: 'form' }
export const FORM_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Sidebar to look up and load another record.', default: true, group: 'form' },
  SAVE_CANCEL_FEATURE,
  ...RECORD_FORM_FEATURES
]
/**
 * MASTER_DETAIL's own catalog - each visit opens a brand-new record (the
 * table's own defaults), so the record actions that move to or duplicate
 * another record (Search, Clone, Save & New, Previous/Next) don't apply.
 */
export const MASTER_DETAIL_FEATURES: DataViewFeatureMeta[] = [
  SAVE_CANCEL_FEATURE,
  ...RECORD_FORM_FEATURES.filter(f => ['recordCopy', 'recordPrint', 'recordHistory'].includes(f.key))
]
/**
 * CARDS' own catalog - a grid of cards over the same rows/toolbar TABLE
 * uses (search/savedViews/history/filter/import/export/refresh all
 * still apply), minus three TABLE-only entries that don't mean anything
 * for a card layout: `density` (no table rows to pad), `columnsToggle`
 * (no grid columns to show/hide - the wizard's Columns step still picks
 * which fields exist at all, just not as toggleable grid columns), and
 * `rowEdit` (TABLE's switchable "click a row to edit" - a card is ALWAYS
 * clickable-to-edit, the whole point of the layout, so
 * there's nothing to toggle). `print` also isn't offered - no bespoke
 * "print a card grid" is planned. Same `...RECORD_FORM_FEATURES` tail as
 * TABLE/FORM - a card's Edit form is the exact same the record form frame
 * component either way.
 */
export const CARDS_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the grid.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/columns/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the grid.', default: true, group: 'table' },
  { key: 'cardDensity', label: 'Card size', description: 'Card size switcher - normal, compact (image and title), very compact (the image alone).', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * MAP's own catalog - same rationale as CARDS_FEATURES just above (a pin
 * grid over the same rows/toolbar TABLE uses), minus the same three
 * TABLE-only entries CARDS already drops (`density`, `columnsToggle`,
 * `rowEdit` - none mean anything without table rows/grid columns, and a
 * pin's "click to act" goes through its popup, not a bare click like
 * Cards). `print` also isn't offered, same as CARDS. Same
 * `...RECORD_FORM_FEATURES` tail - a pin's Edit form is the exact same
 * record form frame as everywhere else.
 */
export const MAP_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the map.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the map.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * KANBAN's own catalog - a board of lanes/cards over the same rows/
 * toolbar TABLE uses, same rationale as CARDS_FEATURES/MAP_FEATURES just
 * above (minus the same three TABLE-only entries neither of those offer
 * either: `density`, `columnsToggle`, `rowEdit` - none mean anything
 * without table rows/grid columns, and a Kanban card's "click to act"
 * goes through its own click handler same as a Card, not a switchable row
 * click). `print` also isn't offered, same as CARDS/MAP - no bespoke
 * "print a board" is planned. Same `...RECORD_FORM_FEATURES` tail - a
 * card's Edit form is the exact same record form frame as
 * everywhere else.
 */
export const KANBAN_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the board.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the board.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * CALENDAR's own catalog - a month/week/day/agenda grid over the same
 * rows/toolbar TABLE uses, same rationale as CARDS_FEATURES/MAP_FEATURES/
 * KANBAN_FEATURES just above (minus the same three TABLE-only entries
 * none of those offer either: `density`, `columnsToggle`, `rowEdit` -
 * none mean anything without table rows/grid columns, and an event's
 * "click to act" goes through its own click handler same as a Card/pin,
 * not a switchable row click). `print` also isn't offered, same as CARDS/
 * MAP/KANBAN - no bespoke "print a calendar" is planned. Same
 * `...RECORD_FORM_FEATURES` tail - an event's Edit form is the exact
 * same record form frame as everywhere else.
 */
export const CALENDAR_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the calendar.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the calendar.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * GANTT's own catalog - timeline bars over the same rows/toolbar TABLE
 * uses, same rationale as CARDS_FEATURES/MAP_FEATURES/KANBAN_FEATURES/
 * CALENDAR_FEATURES just above (minus the same three TABLE-only entries
 * none of those offer either: `density`, `columnsToggle`, `rowEdit` -
 * none mean anything without table rows/grid columns, and a bar's
 * "click to act" goes through its own click handler same as a Card/pin/
 * event, not a switchable row click). `print` also isn't offered, same as
 * CARDS/MAP/KANBAN/CALENDAR - no bespoke "print a timeline" is planned.
 * Same `...RECORD_FORM_FEATURES` tail - a task's Edit form is the exact
 * same record form frame as everywhere else.
 */
export const GANTT_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the timeline.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the timeline.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/** TREE's catalog (DataViews.md §5.14) - the same toolbar and record form as GANTT's. */
export const TREE_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Free-text search box above the tree - a match shows with its parents.', default: true, group: 'table' },
  { key: 'savedViews', label: 'Saved views', description: 'Bookmark button - named, reusable snapshots of filter/sort.', default: true, group: 'table' },
  { key: 'history', label: 'Activity', description: 'Table-wide Activity button, next to Saved views - every change to its rows.', default: true, group: 'table' },
  { key: 'filter', label: 'Filter', description: 'Advanced filter panel (field/operator/value).', default: true, group: 'table' },
  { key: 'import', label: 'Import', description: 'Bulk-import rows from a file.', default: true, group: 'table' },
  { key: 'export', label: 'Export', description: 'Download the current rows as CSV.', default: true, group: 'table' },
  { key: 'refresh', label: 'Refresh', description: 'Manual "Refresh" button above the tree.', default: true, group: 'table' },
  ...RECORD_FORM_FEATURES
]
/**
 * EXTERNALFRAME's own catalog - the only two header actions an embedded
 * page gets (no toolbar, no record actions): both optional, so a report
 * can open in a new tab or go fullscreen while a small widget embed shows
 * neither.
 */
export const EXTERNALFRAME_FEATURES: DataViewFeatureMeta[] = [
  { key: 'openInNewTab', label: 'Open in new tab', description: 'Header button that opens the page in a new browser tab - also the way out when a site refuses to be embedded.', default: true, group: 'frame' },
  { key: 'fullscreen', label: 'Fullscreen', description: 'Header button that shows the page fullscreen.', default: true, group: 'frame' }
]

/** SETTINGS: its search box - no New, Delete or record form (the settings come with the installation). */
export const SETTINGS_FEATURES: DataViewFeatureMeta[] = [
  { key: 'search', label: 'Search', description: 'Search box over the settings\' titles and descriptions.', default: true, group: 'table' }
]
export const DATAVIEW_FEATURES: Partial<Record<DataViewType, DataViewFeatureMeta[]>> = {
  SETTINGS: SETTINGS_FEATURES,
  TABLE: TABLE_FEATURES,
  FORM: FORM_FEATURES,
  CARDS: CARDS_FEATURES,
  MAP: MAP_FEATURES,
  KANBAN: KANBAN_FEATURES,
  CALENDAR: CALENDAR_FEATURES,
  GANTT: GANTT_FEATURES,
  TREE: TREE_FEATURES,
  EXTERNALFRAME: EXTERNALFRAME_FEATURES,
  MASTER_DETAIL: MASTER_DETAIL_FEATURES
}

/**
 * `view_config.form_view_mode` (FORM DataViews only, wizard step 5 /
 * "Edit DataView") - how DataViewRecordPage.vue's own form opens:
 * - `READ` (default): the loaded record opens `'view'` (read-only);
 *   `canWrite` gates whether Edit/New even show at all (this is a
 *   PRESENTATION default, not access control - same disclaimer as
 *   `ColumnSync`/`resolveBaseWhere` above).
 * - `UPDATE`: same record-loading as READ, but opens straight into
 *   `'edit'` - no read-only step first.
 * - `CREATE`: the form is ALWAYS a blank `'create'` - no record is ever
 *   loaded, Search/Edit/Prev-Next/Delete never show (there's nothing to
 *   browse to), and a successful save resets back to a fresh blank
 *   create instead of showing the row just written (a kiosk/continuous-
 *   intake form, not a confirmation screen).
 */
export type FormViewMode = 'CREATE' | 'READ' | 'UPDATE' | 'SINGLE'
export const FORM_VIEW_MODE_META: Record<FormViewMode, { label: string, description: string }> = {
  READ: { label: 'Read', description: 'Opens read-only. Edit/New available per permissions (default).' },
  UPDATE: { label: 'Update', description: 'Opens the loaded record already in edit mode - no read-only step.' },
  CREATE: { label: 'Create', description: 'Always a blank form for new records - no browsing or editing existing ones.' },
  SINGLE: { label: 'Single record', description: 'The table\'s one row, opened to edit - created on the first save when there is none. No New, search, browsing, copy or delete.' }
}
const DEFAULT_FORM_VIEW_MODE: FormViewMode = 'READ'
export function resolveFormViewMode(viewConfig: Record<string, unknown>): FormViewMode {
  const stored = viewConfig.form_view_mode
  return stored === 'CREATE' || stored === 'UPDATE' || stored === 'SINGLE' ? stored : DEFAULT_FORM_VIEW_MODE
}

/**
 * `view_config.open_with` (MASTER_DETAIL only) - what opening the DataView
 * shows: a new record straight away (`NEW_RECORD`, the default), or a start
 * screen whose New button starts one (`WAIT`) - `new_record_label` is that
 * button's text, "New {DataView name}" when unset.
 */
export type MasterDetailOpenWith = 'NEW_RECORD' | 'WAIT'
export const MASTER_DETAIL_OPEN_WITH_META: Record<MasterDetailOpenWith, { label: string, description: string }> = {
  NEW_RECORD: { label: 'New record', description: 'Opens a new record right away, from the table\'s defaults (default).' },
  WAIT: { label: 'Wait for New', description: 'Opens on a New button - each click starts a record.' }
}
export function resolveMasterDetailOpenWith(viewConfig: Record<string, unknown>): MasterDetailOpenWith {
  return viewConfig.open_with === 'WAIT' ? 'WAIT' : 'NEW_RECORD'
}
/** `fallback` - the UI's "New {name}" (`dataviews.meta.newRecordLabel`); English when not given. */
export function resolveNewRecordLabel(viewConfig: Record<string, unknown>, dataviewName: string, fallback?: (name: string) => string): string {
  const stored = typeof viewConfig.new_record_label === 'string' ? viewConfig.new_record_label.trim() : ''
  return stored || (fallback ? fallback(dataviewName) : `New ${dataviewName}`)
}

/** `view_config.frame_url` - EXTERNALFRAME only, the https page it embeds (validated server-side). */
export function resolveFrameUrl(viewConfig: Record<string, unknown>): string {
  return typeof viewConfig.frame_url === 'string' ? viewConfig.frame_url : ''
}

/**
 * Feature flags for a DataView's own type, catalog defaults filled in for
 * whatever `view_config.features` doesn't mention - covers DataViews
 * created before this step existed (`view_config: {}`), which should
 * behave exactly as before (every feature at its catalog default) rather
 * than losing search/filter/etc. because they predate the flag.
 */
export function resolveFeatures(type: DataViewType, viewConfig: Record<string, unknown>): Record<string, boolean> {
  const catalog = DATAVIEW_FEATURES[type] ?? []
  const stored = (viewConfig.features as Record<string, boolean> | undefined) ?? {}
  return Object.fromEntries(catalog.map(f => [f.key, stored[f.key] ?? f.default]))
}

/**
 * What changed in a grid (an embedded DataView's Rows changed, DataViews.md §9.7): a row
 * created, edited (a move on a board too), deleted or rows imported - and the rows saved or deleted (an
 * import lists none: its count is in the toast and the audit).
 */
export interface RowsChange { action: 'create' | 'update' | 'delete' | 'import', rows: Record<string, unknown>[] }

/**
 * A list view's own toolbar controls (DataViews.md §5.13) - the rest of a list's `table`
 * features are its common toolbar, the same in every view. Settings shows these in the view's own tab.
 */
export const LIST_VIEW_OWN_FEATURES: Partial<Record<DataViewType, string[]>> = {
  TABLE: ['density', 'columnsToggle', 'print', 'rowEdit'],
  CARDS: ['cardDensity']
}
/** True for a list's common toolbar feature (search, filter, export…) - not one view's own. */
export function isListCommonFeature(feature: DataViewFeatureMeta): boolean {
  return feature.group === 'table' && !Object.values(LIST_VIEW_OWN_FEATURES).some(keys => keys?.includes(feature.key))
}
/** Every list view's features (a list DataView may switch to any of them): each key at its stored value, else its default. */
export function resolveListFeatures(viewConfig: Record<string, unknown>): Record<string, boolean> {
  return Object.assign({}, ...LIST_DATAVIEW_TYPES.map(type => resolveFeatures(type, viewConfig)))
}

/**
 * How a `TABLE`/`CARDS` DataView opens its Edit form from the grid
 * (DataViews.md §6.3) - `DRAWER`/
 * `MODAL`/`SIDEBAR` map 1:1 to components already in real use elsewhere
 * in the admin (`AppDrawer`/`UModal`/`USlideover`); `PAGE` instead
 * navigates to a dedicated route (`/dataviews/:slug/new` and
 * `/dataviews/:slug/:pk/edit`) - its own linkable URL, for a form long
 * enough that even an expanded drawer feels cramped.
 */
export type EditPresentation = 'DRAWER' | 'MODAL' | 'SIDEBAR' | 'PAGE'
export const EDIT_PRESENTATION_META: Record<EditPresentation, { label: string, description: string }> = {
  SIDEBAR: { label: 'Sidebar', description: 'Slides in from the side, beside the list - the fields in one column; best for most forms (default).' },
  MODAL: { label: 'Modal', description: 'Centered dialog - best for short forms with few fields.' },
  DRAWER: { label: 'Drawer', description: 'Slides up from the bottom, covering most of the screen - for a heavy form: a rich text editor, tabs, a detail.' },
  PAGE: { label: 'Page', description: 'Its own dedicated URL - best for long forms with many fields, like the Settings pages.' }
}
const DEFAULT_EDIT_PRESENTATION: EditPresentation = 'SIDEBAR'

/** `view_config.edit_presentation`, defaulted for DataViews created before this setting existed. */
export function resolveEditPresentation(viewConfig: Record<string, unknown>): EditPresentation {
  const stored = viewConfig.edit_presentation
  return stored === 'DRAWER' || stored === 'MODAL' || stored === 'SIDEBAR' || stored === 'PAGE' ? stored : DEFAULT_EDIT_PRESENTATION
}

/**
 * How big the Edit form's own container is - DRAWER/MODAL/SIDEBAR only
 * (PAGE is a full route, sizing it wouldn't mean anything). Same sm/md/
 * lg/xl scale for all three even though each maps it to a different
 * mechanism underneath: DRAWER's collapsed width (AppDrawer's own
 * `size`), MODAL/SIDEBAR's max-width (`:ui.content`, since neither Nuxt
 * UI component has a discrete size prop of its own) - one scale the user
 * learns once, not three.
 */
export type EditSize = 'sm' | 'md' | 'lg' | 'xl'
export const EDIT_SIZE_META: Record<FormSize, { label: string }> = {
  default: { label: 'Default' },
  sm: { label: 'Small' },
  md: { label: 'Medium' },
  lg: { label: 'Large' },
  xl: { label: 'Extra large' }
}
/**
 * A record form's size as its container takes it: one of the scale, or `default` - none chosen
 * (`edit_size` unset): a Modal's or a Sidebar's own Nuxt UI width, a Drawer's usual collapsed width (EDIT_FORM_WIDTH, AppDrawer).
 */
export type FormSize = EditSize | 'default'
/** What the author chose - null: Default. */
export function storedEditSize(viewConfig: Record<string, unknown>): EditSize | null {
  const stored = viewConfig.edit_size
  return stored === 'sm' || stored === 'md' || stored === 'lg' || stored === 'xl' ? stored : null
}
export function resolveEditSize(viewConfig: Record<string, unknown>): FormSize {
  return storedEditSize(viewConfig) ?? 'default'
}

/** Which side SIDEBAR slides in from - USlideover's own `side` prop, exposed as-is (all four are real, equally-supported options, not just left/right). Meaningless for every other presentation. */
export type EditSide = 'left' | 'right' | 'top' | 'bottom'
export const EDIT_SIDE_META: Record<EditSide, { label: string }> = {
  left: { label: 'Left' },
  right: { label: 'Right' },
  top: { label: 'Top' },
  bottom: { label: 'Bottom' }
}
const DEFAULT_EDIT_SIDE: EditSide = 'right'
export function resolveEditSide(viewConfig: Record<string, unknown>): EditSide {
  const stored = viewConfig.edit_side
  return stored === 'left' || stored === 'right' || stored === 'top' || stored === 'bottom' ? stored : DEFAULT_EDIT_SIDE
}

/** Horizontal placement of the form itself within a `PAGE` edit-presentation's route (`/dataviews/:slug/new`, `/dataviews/:slug/:pk/edit`) - meaningless for DRAWER/MODAL/SIDEBAR, which already center or fill their own container. */
export type PageContentAlign = 'left' | 'center' | 'right'
export const PAGE_CONTENT_ALIGN_META: Record<PageContentAlign, { label: string }> = {
  left: { label: 'Left' },
  center: { label: 'Center' },
  right: { label: 'Right' }
}
const DEFAULT_PAGE_CONTENT_ALIGN: PageContentAlign = 'center'
/** The DataView's own Content align - null: the instance's (Settings > DataViews). */
export function storedPageContentAlign(viewConfig: Record<string, unknown>): PageContentAlign | null {
  const stored = viewConfig.page_content_align
  return stored === 'left' || stored === 'center' || stored === 'right' ? stored : null
}
export function resolvePageContentAlign(viewConfig: Record<string, unknown>, fallback: PageContentAlign = DEFAULT_PAGE_CONTENT_ALIGN): PageContentAlign {
  return storedPageContentAlign(viewConfig) ?? fallback
}
/** How wide a page's form grows (`view_config.page_content_width`) - the same pages Content align applies to (FORM, MASTER_DETAIL, a TABLE's PAGE edit form). Full width fills the page, so its alignment no longer matters. */
export type PageContentWidth = 'narrow' | 'wide' | 'full'
export const PAGE_CONTENT_WIDTH_META: Record<PageContentWidth, { label: string }> = {
  narrow: { label: 'Narrow' },
  wide: { label: 'Wide' },
  full: { label: 'Full width' }
}
const DEFAULT_PAGE_CONTENT_WIDTH: PageContentWidth = 'narrow'
/** The DataView's own Content width - null: the instance's (Settings > DataViews). */
export function storedPageContentWidth(viewConfig: Record<string, unknown>): PageContentWidth | null {
  const stored = viewConfig.page_content_width
  return stored === 'narrow' || stored === 'wide' || stored === 'full' ? stored : null
}
export function resolvePageContentWidth(viewConfig: Record<string, unknown>, fallback: PageContentWidth = DEFAULT_PAGE_CONTENT_WIDTH): PageContentWidth {
  return storedPageContentWidth(viewConfig) ?? fallback
}
/**
 * A page's content box (DataViews.md §6.7): the DataView's own width and align, else the
 * instance's (sent with the DataView - Settings > DataViews > Page width), else the product's - a record
 * page narrow, a CUSTOM page full, centered.
 */
export function pageContentClassOf(dataview: Pick<DataView, 'viewConfig' | 'instancePageLayout'>, page: 'record' | 'custom'): string {
  const config = dataview.viewConfig ?? {}
  const instance = dataview.instancePageLayout
  const width = resolvePageContentWidth(config, (page === 'custom' ? instance?.customWidth : instance?.recordWidth) ?? (page === 'custom' ? 'full' : DEFAULT_PAGE_CONTENT_WIDTH))
  return pageContentClass(resolvePageContentAlign(config, instance?.align ?? DEFAULT_PAGE_CONTENT_ALIGN), width)
}
/**
 * `view_config.fit_to_screen` (FORM/MASTER_DETAIL) - the form fills the page
 * instead of scrolling it: every canvas row keeps its natural height except
 * the one holding a control marked Fill height (`config.fillHeight`, a
 * Detail), which takes the rest and scrolls inside - rows above it
 * read as a header, rows below as a footer. Ignored on a phone or a tablet.
 */
export function resolveFitToScreen(viewConfig: Record<string, unknown>): boolean {
  return viewConfig.fit_to_screen === true
}
/**
 * `view_config.kiosk` (CUSTOM, DataViews.md §7.3) - the page
 * alone on screen, without the App's menu or the page header: a totem, a
 * phone used as a reader.
 */
export function resolveKiosk(viewConfig: Record<string, unknown>): boolean {
  return viewConfig.kiosk === true
}
const PAGE_CONTENT_MAX_WIDTH: Record<PageContentWidth, string> = { narrow: 'max-w-4xl', wide: 'max-w-7xl', full: 'max-w-none' }
/** Tailwind classes for the form's own max-width + horizontal placement - shared by every page that renders a DataView's form (new.vue, [pk]/edit.vue, DataViewRecordPage.vue) rather than duplicating the mx-auto/ml-auto logic. */
export function pageContentClass(align: PageContentAlign, width: PageContentWidth): string {
  // `w-full` - the form sits in a flex column, where an auto margin alone shrinks it to its content's width.
  const maxWidth = PAGE_CONTENT_MAX_WIDTH[width]
  if (width === 'full') return `w-full ${maxWidth}`
  switch (align) {
    case 'left': return `w-full ${maxWidth}`
    case 'right': return `w-full ${maxWidth} ml-auto`
    case 'center': return `w-full ${maxWidth} mx-auto`
  }
}

/**
 * `view_config.column_sync` - what happens to a column the underlying
 * table has that this DataView doesn't yet have a field for (a real
 * schema change, reconciled by `syncFields()`), and whether the Design
 * form's palette may add one that already exists but was never
 * selected. Chosen in the wizard's Columns step, editable later from
 * the DataView's Settings page - a DataView-level SETTING,
 * not a per-field layout thing, so it lives there rather than the
 * Design form's own canvas/palette/inspector (Settings owns every
 * general DataView-level behavior, Design form only field layout).
 *
 * PRESENTATION ONLY - this is the one thing the copy wherever this is
 * shown must never blur (a user once asked
 * whether `locked` could double as a way to keep a sensitive column,
 * e.g. salary, out of a view - it can't): a `locked` DataView still
 * returns every column to anyone who queries the underlying table
 * directly - the public Data API, the SQL Console, a different
 * DataView over the same table. Real field-level access control is a
 * permission grant, not this.
 */
export type ColumnSync = 'auto_show' | 'auto_hide' | 'locked'
export const COLUMN_SYNC_META: Record<ColumnSync, { label: string, description: string }> = {
  auto_show: { label: 'Add them shown', description: 'In the list and at the end of the record form (default).' },
  auto_hide: { label: 'Add them hidden', description: 'In the list, hidden - read, not shown, until someone shows it; not in the form.' },
  locked: { label: 'Don\'t add them', description: 'The DataView keeps the columns it has - Add columns… can still bring one in.' }
}
const DEFAULT_COLUMN_SYNC: ColumnSync = 'auto_show'
export function resolveColumnSync(viewConfig: Record<string, unknown>): ColumnSync {
  const stored = viewConfig.column_sync
  return stored === 'auto_show' || stored === 'locked' ? stored : DEFAULT_COLUMN_SYNC
}
/** Fixed, always-visible disclaimer next to the Column set control (both the wizard and "Edit DataView") - never a tooltip someone can miss, the whole point is nobody mistakes this for access control. */
export const COLUMN_SYNC_SCOPE_NOTICE = 'Controls what this VIEW reads, not who can see it. Anyone with access to the table via the API or SQL Console still sees every column they may read - use Permissions to actually restrict a column.'

/**
 * `view_config.base_where` - a permanent filter condition (the SAME
 * `_eq`/`_and`/`_or`/... grammar the grid's own ad-hoc filter box and
 * a Detail widget's own scoping use) merged into EVERY query this
 * DataView makes - e.g. "only show products where active = true",
 * regardless of whatever the viewer's own filter box adds on top.
 *
 * Reuses DataViewGrid.vue's own `forcedWhere` prop/merge order
 * (`...whereParams, ...forcedWhereParams` - the base filter always wins
 * on a shared key) - previously only ever fed by a Detail widget's own
 * FK-scoping condition (WidgetDataView.vue); this is the SAME
 * mechanism, just sourced from the DataView's own settings instead of
 * a parent embed. When a DataView with its own `base_where` is ALSO
 * embedded, WidgetDataView.vue combines both with `_and` - neither
 * one is allowed to silently override the other on a shared column.
 *
 * PRESENTATION ONLY - same disclaimer, same reasoning as
 * `column_sync`: this is a client-merged query-string filter, not a
 * permission. Anyone who can already read the underlying table without
 * going through this DataView (a direct API call, SQL Console, a
 * different DataView over the same table) is unaffected by it.
 */
export function resolveBaseWhere(viewConfig: Record<string, unknown>): Record<string, unknown> | undefined {
  const stored = viewConfig.base_where
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : undefined
}
export const BASE_WHERE_SCOPE_NOTICE = 'Filters which ROWS this VIEW shows, not who can see them. Anyone with access to the table via the API or SQL Console still sees every row regardless of this filter - use Permissions to actually restrict rows.'

/**
 * Auto-refresh (Edit DataView's Features tab) - a default interval the
 * standalone page's grid re-fetches on, same Grafana-style duration
 * string DataViewGrid.vue already accepts via its own `?refresh=` URL
 * param (parse-refresh-interval.ts) and a Detail widget's own per-field
 * "Auto-refresh" property. This is the SAME string shape, just stored as
 * the DataView's own default instead of per-viewer/per-embed - a viewer
 * visiting the URL directly can still override it with `?refresh=...`
 * (DataViewGrid.vue's own `refreshIntervalSource`: the URL always wins
 * when present).
 */
// `value: 'off'`, not `''` - reka-ui's Combobox reserves an empty string
// for "no selection" and throws if any item uses it.
export const AUTO_REFRESH_PRESETS: { label: string, value: string }[] = [
  { label: 'Off', value: 'off' },
  { label: '10s', value: '10s' },
  { label: '30s', value: '30s' },
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: 'Custom…', value: 'custom' }
]
/** `null` (never configured, or explicitly cleared) means no default - same "off unless a viewer's own `?refresh=` says otherwise" behavior as before this setting existed. */
export function resolveAutoRefresh(viewConfig: Record<string, unknown>): string | null {
  const stored = viewConfig.auto_refresh
  return typeof stored === 'string' && stored.trim() ? stored.trim() : null
}

/** The grid's own "Rows per page" choices (`DataViewGrid.vue`'s toolbar select) - shared here so the DataView settings page's own "Default page size" picker (`view_config.default_state.pageSize`) can only ever offer a value a viewer could actually pick themselves later, never a stray number nobody's UI exposes. */
export const PAGE_SIZE_OPTIONS: number[] = [10, 20, 50, 100]

/**
 * The DataView-wide default grid state (columns/order, sort, density) -
 * "Set as default for everyone" (globe icon, header of the grid's own
 * "Saved views" panel)
 * (any admin who can reach the grid at all, same access every other
 * setting here needs - no separate permission). Same shape as a
 * viewer's own personal auto-saved state (DataViewGrid.vue's
 * `UserPrefsConfig`) - just the fallback a first-time viewer (or anyone
 * who never customized anything) gets instead of raw DB column order,
 * rather than one MORE per-viewer default. Deliberately excludes a
 * filter (`where`) - that's already `base_where`'s own job (a
 * permanent, forced condition), not this one's.
 */
export function resolveDefaultState(viewConfig: Record<string, unknown>): Record<string, unknown> {
  const stored = viewConfig.default_state
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {}
}

export interface DataView {
  id: string
  name: string
  slug: string
  /** What the App menu shows - null: its name. Live, never versioned. */
  menuLabel?: string | null
  /** The live (highest) version (Foundations.md §13.1), null until first published. */
  liveVersion?: number | null
  /** The draft differs from the live version (or there is none) - `GET /dataviews` and `GET /dataviews/:id` (admin) only. */
  hasUnpublishedChanges?: boolean
  description: string | null
  icon: string | null
  color: RoleColor | null
  sourceResource: string | null
  sourceResourceSchema: string | null
  sourceResourceName: string | null
  /** TABLE vs. VIEW - the write-actions gate (DataViews.md §1.2: a VIEW source stays read-only regardless of layout). */
  sourceResourceType: 'TABLE' | 'VIEW' | null
  /** Needed by the Design form (and the Edit form's FK picker) to call `GET /catalog/table|view/:oid` directly. */
  sourceResourceOid: number | null
  viewType: DataViewType
  scope: DataViewScope
  viewConfig: Record<string, unknown>
  /** CUSTOM only: each resource its variables name (by id), with the schema and name the Data API addresses it by. */
  variableResources?: Record<string, { schema: string, name: string, type: string, columns?: Record<string, string>, relations?: Record<string, string>, displays?: Record<string, { schema: string, table: string, column: string, displayField: string, displayTemplate?: string }> }>
  /** The workflows its Calls run, by id - the slug each runs by (a Call stores the id). */
  variableWorkflows?: Record<string, { slug: string, name: string }>
  /**
   * What it inherits from its resources' columns (DataViews.md §15),
   * by resource id and column name: live on a draft read, the
   * version's frozen copy on a published one.
   */
  columnPresentation?: Record<string, Record<string, ColumnPresentation>>
  /** The App's read only: the `fk.related` paths its formulas use that this viewer may not read - left out of the grid's `fields`, read as empty. */
  deniedRelationPaths?: string[]
  /** The App's read only: what this viewer may do to its source's rows (their grants) - New, editing and Delete show only where allowed. Absent (a draft, the admin's own read): everything. */
  viewerActions?: { create: boolean, update: boolean, delete: boolean }
  /** The most rows a viewer may choose and edit together - dataviews.bulk_edit_max_rows (DataViews.md §5.15). */
  bulkEditMaxRows?: number
  /** Its custom actions this viewer may run, by id, with what each calls (DataViews.md §3.7). */
  actionTargets?: Record<string, ActionTarget>
  /** What the viewer is granted, before the DataView's own Allow - what an embed of it (TDataView) narrows with its own (DataViews.md §5.1). */
  grantedActions?: { create: boolean, update: boolean, delete: boolean }
  /** The App's read only: the instance's toolbar default (Settings > DataViews > Toolbar) - null for automatic, the type's own (DataViews.md §5). */
  instanceToolbarMode?: 'full' | 'compact' | null
  /** The App's read only: the instance's page width defaults (Settings > DataViews > Page width, DataViews.md §6.7). */
  instancePageLayout?: { recordWidth: PageContentWidth, customWidth: PageContentWidth, align: PageContentAlign, tableMargin?: ListMargin }
  /** Draft client-side controller code from the Studio Design drawer's Code tab. On a `/published` read, this is the latest publish's code instead of the live draft - see usePublishedDataViewBySlug's own doc comment. */
  code: string
  createdAt: string
  updatedAt: string
  /** Only present on GET-by-id/-slug (not list()) - see the service's own doc comment. */
  sourceResourcePrimaryKey?: string[]
}

/** COLUMN: a source column. RELATED: a column of the table a foreign key points at (`columnName` its path, `brand.country`). WIDGET: a page's widget. */
export type DataViewFieldKind = 'COLUMN' | 'RELATED' | 'WIDGET'

export interface DataViewField {
  id: string
  /** COLUMN - a column of the source table (the grid's column, its format); WIDGET - a widget placed on the DataView's page. */
  kind: DataViewFieldKind
  /** WIDGET fields only: the widget whose slot (`config.slot`) holds it - null on the canvas itself. */
  parent: string | null
  gridX: number
  gridY: number
  gridW: number
  gridH: number
  label: string | null
  icon: string | null
  columnAttnum: number | null
  columnName: string | null
  widget: string | null
  visible: boolean
  config: Record<string, unknown>
  /** A Detail widget's DataView (synced from its `dataview` prop). */
  relatedDataview: string | null
  /** COLUMN/RELATED: what it inherits from its resource's column (DataViews.md §15) - live on a draft, frozen on a published read; its own label and config override it. */
  inherited?: ColumnPresentation
  /** COLUMN/RELATED: its column's PostgreSQL type, read live. */
  dataType?: string
}

/**
 * `view_config.card_layout` (CARDS DataViews only, wizard step "Card
 * layout" / "Edit DataView") - which text each card's Image/Title/
 * Description slots show, evaluated as a bindings v2 FORMULA
 * (formula-engine.ts) - the same engine/modal (`BindingButton.vue`)
 * every other bindable property in the app already uses (the older,
 * plain `{{column}}`-substitution engine this used to compete with -
 * resolve-template.ts - has since been fully migrated over and deleted).
 * Prompted by a user question ("can't Card image/title/description bind
 * to a column, with the same binding-modal icon Visible/Disabled get?")
 * - a formula can combine columns (`CONCATENATE({{first_name}}, " ",
 * {{last_name}})`), branch on a value (`{{status}} == "vip" ? "⭐" :
 * ""`), or just be a bare `{{column}}` identifier, which evaluates to
 * that column's own value same as any other formula does.
 *
 * The wizard's own Card layout step still only offers a plain column
 * PICKER (one USelectMenu, no formula typing) for the common case - it
 * just wraps the choice as the bare formula `"{{column}}"` before
 * saving here; the DataView's Settings page is where a
 * builder gets the real `BindingButton` to type/build a richer formula.
 * Still a DataView-level layout setting, not a per-field `config` flag
 * (the same column could be reused as a plain visible field elsewhere
 * without dragging a "this is the title" flag along with it).
 *
 * `imageFormula`/`descriptionFormula` are optional (an image-less/
 * subtitle-less card is a real layout, not a partial one); `titleFormula`
 * is the one required slot - DataViewCard.vue always needs a headline to
 * show, so an empty/missing one falls back to the bare formula
 * `"{{firstVisibleColumn}}"` (never headline-less). A
 * formula can reference a column later hidden/removed without this
 * resolver ever throwing (`evaluateFormula` itself never throws either -
 * an unparseable/unknown-column formula comes back `{ ok: false }`,
 * the caller's own job to fall back to `''`, same convention every
 * other formula caller in the app already follows).
 */
export interface CardLayoutConfig {
  imageFormula: string | null
  titleFormula: string | null
  descriptionFormula: string | null
  /** The image's shape - null: a 16:9 band, as before there was a choice; original: the image's own. */
  imageAspect?: CardImageAspect | null
  /** cover fills the shape and crops (default); contain shows all of it. */
  imageFit?: 'cover' | 'contain' | null
  /** Where cover crops from - top keeps a portrait's face; center (default). */
  imagePosition?: 'top' | 'center' | null
}
export const CARD_IMAGE_ASPECTS = ['original', '1:1', '3:4', '4:3', '16:9'] as const
export type CardImageAspect = typeof CARD_IMAGE_ASPECTS[number]
export function resolveCardLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): CardLayoutConfig {
  const stored = (viewConfig.card_layout as Partial<CardLayoutConfig> | undefined) ?? {}
  const imageFormula = typeof stored.imageFormula === 'string' && stored.imageFormula.trim() ? stored.imageFormula : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName)?.columnName
  const titleFormula = typeof stored.titleFormula === 'string' && stored.titleFormula.trim()
    ? stored.titleFormula
    : (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null)
  const descriptionFormula = typeof stored.descriptionFormula === 'string' && stored.descriptionFormula.trim() ? stored.descriptionFormula : null
  const imageAspect = CARD_IMAGE_ASPECTS.find(a => a === stored.imageAspect) ?? null
  const imageFit = stored.imageFit === 'contain' || stored.imageFit === 'cover' ? stored.imageFit : null
  const imagePosition = stored.imagePosition === 'top' || stored.imagePosition === 'center' ? stored.imagePosition : null
  return { imageFormula, titleFormula, descriptionFormula, imageAspect, imageFit, imagePosition }
}

/**
 * `view_config.kanban_layout` (KANBAN DataViews only, wizard step "Kanban
 * layout" / "Edit DataView"). The board's lanes are NOT free-text distinct
 * values of some column (over-engineering, explicitly ruled out) -
 * `groupColumn` is always a Foreign Key column
 * (same `widget === 'USelectMenu'` + `config.display_field`/
 * `display_field_target` marker every FK select column already carries,
 * see ForeignKeySelect.vue/field-config.ts), and every lane is one ROW of
 * that FK's own target table - its PK is the lane's identity, its
 * `display_field` value is the lane's title. There is deliberately no
 * per-lane color here (no "carril color" setting, v1 stays minimal,
 * same anti-over-engineering call as the rest of this project) - a lane
 * is just a header plus its cards.
 *
 * `titleFormula`/`descriptionFormula`/`imageFormula` reuse CARD_LAYOUT's
 * exact mechanism (`resolveCardLayout`'s own doc comment just above) -
 * same bindings v2 FORMULA engine, same wizard-simple/edit-rich split,
 * same "never headline-less" `titleFormula` fallback. A Kanban card is
 * visually CARDS' own card, just grouped into columns instead of a flat
 * grid - there's no reason for its content mechanism to be anything else.
 *
 * `laneOrder` is an explicit list of the related table's own PK values
 * (as strings - a PK may be numeric/uuid/etc, always compared by its
 * string form here), in display order - editable from the DataView's
 * Settings page (Kanban settings) via plain Move up/down buttons, NOT
 * drag-reordering (the native Drag and Drop API this DataView type uses
 * is reserved for moving CARDS between lanes, not for reordering the
 * lanes themselves - two different gestures would be confusing on the
 * same board). A PK missing from `laneOrder` (the related table gained a
 * row after this was last saved) is appended at the end, in whatever
 * order the related table's own query returned it - see
 * DataViewKanban.vue's own lane-building logic, this resolver only
 * returns the stored preference as-is. A record whose `groupColumn`
 * value is `null` (or references a PK no longer in the related table)
 * always renders in a fixed "Unassigned" lane after every real lane -
 * not part of `laneOrder` at all, since it isn't a real related-table row.
 */
export interface KanbanLayoutConfig {
  groupColumn: string | null
  titleFormula: string | null
  descriptionFormula: string | null
  imageFormula: string | null
  laneOrder: string[]
  /** A column of the related table (the lanes' own rows) ordering them - its `position`, set at creation when it has one. `laneOrder` still wins for a lane it lists. Null: by the lane's name. */
  laneOrderColumn: string | null
  /** A column of the related table holding each lane's color (a palette name or hex), set at creation when it has a `color`. Null: plain lanes. */
  laneColorColumn: string | null
  /** Cards don't move between lanes - another process sets the column (a function, a workflow). */
  readOnly?: boolean
}
/**
 * The fixed trailing lane's own key (DataViewKanban.vue's `KanbanLane`,
 * DataViewKanbanView.vue's `lanes`/`onMove`) - lives here, not in DataViewKanban.vue itself, because a plain
 * runtime `export const` isn't allowed inside a `<script setup>` SFC
 * (Vue's own compiler error: "<script setup> cannot contain ES module
 * exports") - every OTHER cross-file KANBAN constant already lives in
 * this plain .ts module, so this one does too instead of being the one
 * exception carved out of a component file.
 */
export const KANBAN_UNASSIGNED_KEY = '__unassigned__'
/** Same FK marker `fieldsParam`/ForeignKeySelect's own callers already use (DataViewGrid.vue) - a KANBAN groupColumn must be a real FK select column, never a plain-text column. */
export function isForeignKeyField(field: DataViewField): boolean {
  return field.widget === 'USelectMenu' && !!(field.config as { display_field?: string } | undefined)?.display_field
}
export function resolveKanbanLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): KanbanLayoutConfig {
  const stored = (viewConfig.kanban_layout as Partial<KanbanLayoutConfig> | undefined) ?? {}
  const fkColumns = columns.filter(f => f.kind === 'COLUMN' && f.columnName && isForeignKeyField(f))
  // Group by: a foreign key or a column with a CHECK list - which one it is, the catalog says at runtime.
  const columnNames = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName))
  const groupColumn = typeof stored.groupColumn === 'string' && columnNames.has(stored.groupColumn) ? stored.groupColumn : (fkColumns[0]?.columnName ?? null)
  const pickFormula = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName)?.columnName
  const titleFormula = pickFormula(stored.titleFormula) ?? (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null)
  const laneOrder = Array.isArray(stored.laneOrder) ? stored.laneOrder.filter((v): v is string => typeof v === 'string') : []
  return {
    groupColumn,
    titleFormula,
    descriptionFormula: pickFormula(stored.descriptionFormula),
    imageFormula: pickFormula(stored.imageFormula),
    laneOrder,
    laneOrderColumn: pickRelatedColumn(stored.laneOrderColumn),
    laneColorColumn: pickRelatedColumn(stored.laneColorColumn),
    ...(stored.readOnly === true && { readOnly: true })
  }
}
/** A column of a lanes' related table - a name the resolver can't check (it only knows this DataView's own columns); the lane fetch ignores a stale one. */
function pickRelatedColumn(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** DataViewIconPickerField/ColorPickerField's own sensible fallback for a pin with no per-row icon/color column mapped - a plain, always-visible pin rather than an empty/invisible one. */
export const DEFAULT_MAP_PIN_ICON = 'i-lucide-map-pin'
export const DEFAULT_MAP_PIN_COLOR: RoleColor = DEFAULT_ROLE_COLOR

/**
 * What a pin/event/bar is painted with when its DataView's default color
 * is "No color" (ColorPickerField's `allowNone`, stored as an explicit
 * `defaultColor: null`) - a neutral gray (Tailwind slate-400, readable on
 * both themes; the palette has no gray of its own). A `defaultColor` that
 * was never stored keeps the type's own default (blue), as before.
 */
export const NO_COLOR_SHADE = '#94a3b8'
/** The color a row's item renders with: its formula's result, else the DataView's default color - `null` meaning "No color". */
export function itemColor(formulaResult: string | undefined, defaultColor: RoleColor | null | undefined, typeDefault: RoleColor): string {
  if (formulaResult) return formulaResult
  if (defaultColor === null) return NO_COLOR_SHADE
  return defaultColor ?? typeDefault
}

/**
 * `view_config.map_layout` (MAP DataViews only, wizard step "Map layout" /
 * "Edit DataView"). `latitudeColumn`/`longitudeColumn` stay plain column
 * NAMES, strictly validated against the DataView's columns (shown or hidden) - a coordinate is
 * never sensibly a formula combining columns (there's no meaningful way
 * to "combine" two numbers via string concatenation), so these two keep
 * the original strict-pick shape. `nameFormula`/`descriptionFormula`/
 * `iconFormula`/`colorFormula` instead use the SAME bindings v2 FORMULA
 * mechanism `card_layout` just above adopted (formula-engine.ts,
 * `BindingButton.vue`) - a pin's popup can combine columns
 * (`CONCATENATE({{first_name}}, " ", {{last_name}})`) exactly like a
 * card's title can, and branching a per-row icon/color on a status
 * column is a real ternary (`{{status}} == "active" ? "i-lucide-check"
 * : "i-lucide-x"`), not just aliasing one column's raw value. Same
 * wizard-simple/edit-rich split as `card_layout`: the wizard's Map
 * layout step only offers plain column PICKERS, wrapping each choice as
 * the bare formula `"{{column}}"` before saving; "Edit DataView" is
 * where a builder gets the real `BindingButton` for these four.
 *
 * `nameFormula` is the one required slot (no popup without a headline);
 * an empty/missing one falls back to the bare formula
 * `"{{firstVisibleColumn}}"`, same "never headline-less" default
 * `card_layout`'s own `titleFormula` uses. `descriptionFormula`/
 * `iconFormula`/`colorFormula` are optional - a formula that's empty
 * (unset, or evaluates to `''`/fails for a given row) falls back to the
 * fixed `defaultIcon`/`defaultColor` chosen in the same step
 * (IconPickerField/ColorPickerField), not to some other column.
 *
 * v1 has no geometry/PostGIS column support at all (DataViews.md §5.4) -
 * just two plain numeric columns nominated as lat/lng. There's no
 * sensible fallback for a missing lat/lng column (a map with no
 * position isn't a partial map, it's broken) - callers must gate on
 * those two being non-null themselves (same defensive stance the
 * wizard's "Map layout" step validation and DataViewGrid.vue's MAP
 * branch both need to take).
 */
export interface MapLayoutConfig {
  /** One native `point` column as the location (DataViews.md §5.4) - instead of the latitude/longitude pair. */
  pointColumn: string | null
  latitudeColumn: string | null
  longitudeColumn: string | null
  nameFormula: string | null
  descriptionFormula: string | null
  iconFormula: string | null
  colorFormula: string | null
  defaultIcon: string
  /** `null` = "No color" (NO_COLOR_SHADE) - see `itemColor`. */
  defaultColor: RoleColor | null
}
/** Whether a MAP knows where each row is: a point column, or both latitude and longitude. */
export function mapLocationReady(layout: Pick<MapLayoutConfig, 'pointColumn' | 'latitudeColumn' | 'longitudeColumn'>): boolean {
  return !!layout.pointColumn || !!(layout.latitudeColumn && layout.longitudeColumn)
}
export function resolveMapLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): MapLayoutConfig {
  const stored = (viewConfig.map_layout as Partial<MapLayoutConfig> | undefined) ?? {}
  const names = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName))
  const pickColumn = (value: unknown): string | null => typeof value === 'string' && names.has(value) ? value : null
  const pickFormula = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName)?.columnName
  const pointColumn = pickColumn(stored.pointColumn)
  return {
    pointColumn,
    // The two location modes never mix: a point column wins over a stale pair.
    latitudeColumn: pointColumn ? null : pickColumn(stored.latitudeColumn),
    longitudeColumn: pointColumn ? null : pickColumn(stored.longitudeColumn),
    nameFormula: pickFormula(stored.nameFormula) ?? (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null),
    descriptionFormula: pickFormula(stored.descriptionFormula),
    iconFormula: pickFormula(stored.iconFormula),
    colorFormula: pickFormula(stored.colorFormula),
    defaultIcon: typeof stored.defaultIcon === 'string' && stored.defaultIcon ? stored.defaultIcon : DEFAULT_MAP_PIN_ICON,
    defaultColor: stored.defaultColor === null ? null : typeof stored.defaultColor === 'string' ? stored.defaultColor as RoleColor : DEFAULT_MAP_PIN_COLOR
  }
}

/**
 * `view_config.map_view` (MAP DataViews only, wizard step "Map layout") -
 * the fixed center/zoom the map opens at, chosen via a mini interactive
 * Leaflet embedded in that same wizard step (pan/zoom there writes these
 * three numbers back). Deliberately NOT an auto-fit-to-pins default: the
 * chat's own choice was that this fixed view always wins, pins or not -
 * predictable ("this is the view of this map"), no first-paint jump once
 * data loads. Defaults to a whole-world view at zoom 2 centered on
 * (20, 0) - roughly the Atlantic - so a DataView created before this
 * setting existed (or one where the builder never touched the mini-map)
 * still opens somewhere sane instead of Leaflet's own (0, 0) default.
 */
export interface MapViewConfig {
  centerLat: number
  centerLng: number
  zoom: number
}
export const DEFAULT_MAP_VIEW: MapViewConfig = { centerLat: 20, centerLng: 0, zoom: 2 }
export function resolveMapView(viewConfig: Record<string, unknown>): MapViewConfig {
  const stored = (viewConfig.map_view as Partial<MapViewConfig> | undefined) ?? {}
  const centerLat = typeof stored.centerLat === 'number' && Number.isFinite(stored.centerLat) ? stored.centerLat : DEFAULT_MAP_VIEW.centerLat
  const centerLng = typeof stored.centerLng === 'number' && Number.isFinite(stored.centerLng) ? stored.centerLng : DEFAULT_MAP_VIEW.centerLng
  const zoom = typeof stored.zoom === 'number' && Number.isFinite(stored.zoom) ? stored.zoom : DEFAULT_MAP_VIEW.zoom
  return { centerLat, centerLng, zoom }
}

/** Same "sensible fallback for no per-row color mapped" role `DEFAULT_MAP_PIN_COLOR` plays for MAP - a CALENDAR event has no icon at all (types/dataview.ts's own doc comment on `CalendarLayoutConfig` below: a day-cell chip doesn't need one the way a map pin does), so there's no `DEFAULT_CALENDAR_EVENT_ICON` counterpart. */
export const DEFAULT_CALENDAR_EVENT_COLOR: RoleColor = DEFAULT_ROLE_COLOR

/**
 * `view_config.calendar_layout` (CALENDAR DataViews only, wizard step
 * "Calendar layout" / "Edit DataView"). `dateColumn` stays a plain column
 * NAME, strictly validated against the DataView's columns (shown or hidden) - same reasoning
 * `MapLayoutConfig`'s own `latitudeColumn`/`longitudeColumn` doc comment
 * gives (a date is never sensibly a formula combining columns either).
 *
 * A CALENDAR DataView places rows by a SINGLE date/timestamp column, not
 * a start/end range: GANTT is the type reserved for start/end date
 * columns, so this
 * never grows a second date slot. `titleFormula`/`descriptionFormula`/
 * `colorFormula` reuse the exact same bindings v2 FORMULA mechanism
 * `card_layout`/`map_layout` already use (formula-engine.ts,
 * `BindingButton.vue`) - an event's chip label can combine columns
 * exactly like a card's title can. `colorFormula`/`defaultColor` mirror
 * `MapLayoutConfig` one for one; there's deliberately no icon slot at
 * all (nor a `defaultIcon`) - a day-cell chip has no room for one the way
 * a map pin's own teardrop shape does, and an event doesn't need one.
 *
 * `titleFormula` is the one required slot (no chip without a label); an
 * empty/missing one falls back to the bare formula
 * `"{{firstVisibleColumn}}"`, same "never label-less" default
 * `card_layout`/`map_layout` both use. `descriptionFormula`/
 * `colorFormula` are optional - color falls back to the fixed
 * `defaultColor` chosen in the same step, same as MAP.
 *
 * There's no sensible fallback for a missing `dateColumn` - a calendar
 * with no date to place rows by isn't a partial calendar, it's broken -
 * callers must gate on it being non-null themselves, same defensive
 * stance MAP's own lat/lng already requires.
 */
/** DataViewCalendar.vue's own four views - lives here (not in that component) so `CalendarLayoutConfig.defaultView` below can reference it without a component-to-plain-module import running backwards (types/dataview.ts is the shared, component-agnostic layer every DataView type's config already lives in). */
export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda'

export interface CalendarLayoutConfig {
  dateColumn: string | null
  titleFormula: string | null
  descriptionFormula: string | null
  colorFormula: string | null
  /** `null` = "No color" (NO_COLOR_SHADE) - see `itemColor`. */
  defaultColor: RoleColor | null
  /**
   * Which day a week starts on - `0` (Sunday, `date-fns`'s own default)
   * through `6` (Saturday); `1` is the common "Monday-first" preference
   * some locales/users expect. Threaded through every `date-fns`
   * `startOfWeek`/`endOfWeek` call this DataView's own Month/Week grids
   * and fetch-range make (DataViewCalendar.vue, DataViewGrid.vue's own
   * `calendarRange`) - never hardcoded to Sunday the way it was before
   * this setting existed.
   */
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6
  /** Which of Agenda/Day/Week/Month this DataView opens to - same "remember a per-DataView starting point" role `view_config.form_view_mode`/`default_state` play for FORM/TABLE, just for the one thing those don't cover (CALENDAR has no page/density to default, just a view). Purely a starting point - a viewer can still switch views freely once open, same as any other default. */
  defaultView: CalendarViewMode
}
const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ['month', 'week', 'day', 'agenda']
export function resolveCalendarLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): CalendarLayoutConfig {
  const stored = (viewConfig.calendar_layout as Partial<CalendarLayoutConfig> | undefined) ?? {}
  const names = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName))
  const pickColumn = (value: unknown): string | null => typeof value === 'string' && names.has(value) ? value : null
  const pickFormula = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName)?.columnName
  return {
    dateColumn: pickColumn(stored.dateColumn),
    titleFormula: pickFormula(stored.titleFormula) ?? (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null),
    descriptionFormula: pickFormula(stored.descriptionFormula),
    colorFormula: pickFormula(stored.colorFormula),
    defaultColor: stored.defaultColor === null ? null : typeof stored.defaultColor === 'string' ? stored.defaultColor as RoleColor : DEFAULT_CALENDAR_EVENT_COLOR,
    weekStartsOn: typeof stored.weekStartsOn === 'number' && stored.weekStartsOn >= 0 && stored.weekStartsOn <= 6 ? stored.weekStartsOn as CalendarLayoutConfig['weekStartsOn'] : 0,
    defaultView: typeof stored.defaultView === 'string' && CALENDAR_VIEW_MODES.includes(stored.defaultView as CalendarViewMode) ? stored.defaultView as CalendarViewMode : 'month'
  }
}

/** Same "sensible fallback for no per-row color mapped" role `DEFAULT_MAP_PIN_COLOR`/`DEFAULT_CALENDAR_EVENT_COLOR` play for MAP/CALENDAR - a Gantt bar has no icon either, same reasoning as CALENDAR's own doc comment. */
export const DEFAULT_GANTT_BAR_COLOR: RoleColor = DEFAULT_ROLE_COLOR

/**
 * `view_config.gantt_layout` (GANTT DataViews only, wizard step "Gantt
 * layout" / "Edit DataView"). Reserved by CALENDAR's own doc comment
 * above ("GANTT is the type reserved for start/end date columns") - this
 * is that type, finally implemented.
 *
 * `startDateColumn`/`endDateColumn` stay plain column NAMES, strictly
 * validated against the DataView's columns (shown or hidden) - same reasoning `MapLayoutConfig`'s
 * own `latitudeColumn`/`longitudeColumn` doc comment gives (a date is
 * never sensibly a formula combining columns). Both are REQUIRED - a
 * timeline bar with no start or no end isn't a partial bar, it's broken -
 * callers must gate on both being non-null themselves, same defensive
 * stance MAP's own lat/lng and CALENDAR's own dateColumn already require.
 *
 * `groupColumn` is OPTIONAL, unlike KANBAN's own (required) groupColumn -
 * a Gantt chart is useful either flat (every row its own bar, sorted by
 * start date, the common single-project case) or grouped into swimlanes
 * by a related table's own rows (KanbanLayoutConfig's own doc comment:
 * "always a Foreign Key column... every lane is one ROW of that FK's own
 * target table") when a builder wants rows grouped by project/assignee/
 * etc. `null` means "one flat, ungrouped timeline" - not "broken", unlike
 * a missing start/end date. `laneOrder` mirrors KANBAN's own exactly
 * (same shape, same "starts empty, only ever reordered later from Gantt
 * settings" convention) and is meaningless whenever `groupColumn` itself
 * is null.
 *
 * `titleFormula`/`descriptionFormula`/`colorFormula`/`defaultColor` reuse
 * the exact same bindings v2 FORMULA mechanism (and the exact same
 * "never label-less" `titleFormula` fallback, and CALENDAR's own no-icon
 * `colorFormula`/`defaultColor` pair) as `CalendarLayoutConfig` - a Gantt
 * bar's own label/tooltip/color needs nothing CALENDAR's own event chip
 * doesn't already need.
 *
 * `defaultZoom` is a plain starting-point preference, same role
 * `CalendarLayoutConfig.defaultView` plays for CALENDAR - a viewer can
 * still switch zoom freely once open (DataViewGantt.vue's own zoom
 * switcher), this just picks where a fresh visit starts.
 *
 * `laneColorColumn` is meaningless whenever `groupColumn` itself is null
 * (same as `laneOrder`) - a plain column NAME, but on the RELATED table
 * `groupColumn` points at, not this DataView's own source table (unlike
 * every other column reference in this file). That means it can't be
 * validated against the DataView's columns (shown or hidden) here the way `startDateColumn`/
 * `endDateColumn`/`groupColumn` are - this resolver has no way to know
 * the related table's own columns, only DataViewGanttView.vue's own
 * lane fetch (which DOES query that table directly) can tell a
 * real column from a stale one, so it stays a permissive pass-through
 * string here, same "resolver validates what it CAN, the live fetch
 * silently no-ops on the rest" stance already true of `kanban_layout`'s
 * own `groupColumn` display_field lookup. One shared color per lane
 * (e.g. every task under "Project Alpha" tinted the same) rather than
 * per-bar `colorFormula` - the two are independent and can both be set.
 */
export type GanttZoom = 'day' | 'week' | 'month'
export const GANTT_ZOOM_META: Record<GanttZoom, { label: string }> = {
  day: { label: 'Day' },
  week: { label: 'Week' },
  month: { label: 'Month' }
}
export interface GanttLayoutConfig {
  startDateColumn: string | null
  endDateColumn: string | null
  groupColumn: string | null
  titleFormula: string | null
  descriptionFormula: string | null
  colorFormula: string | null
  /** `null` = "No color" (NO_COLOR_SHADE) - see `itemColor`. */
  defaultColor: RoleColor | null
  laneOrder: string[]
  defaultZoom: GanttZoom
  laneColorColumn: string | null
  /** As KanbanLayoutConfig's: a related-table column ordering the lanes. */
  laneOrderColumn: string | null
  /** A numeric column holding the task's progress, 0-100 - the bar fills up to it. */
  progressColumn: string | null
}
const GANTT_ZOOMS: readonly GanttZoom[] = ['day', 'week', 'month']
export function resolveGanttLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): GanttLayoutConfig {
  const stored = (viewConfig.gantt_layout as Partial<GanttLayoutConfig> | undefined) ?? {}
  const names = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName))
  const fkNames = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName && isForeignKeyField(f)).map(f => f.columnName))
  const pickColumn = (value: unknown): string | null => typeof value === 'string' && names.has(value) ? value : null
  const pickFormula = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName)?.columnName
  const laneOrder = Array.isArray(stored.laneOrder) ? stored.laneOrder.filter((v): v is string => typeof v === 'string') : []
  return {
    startDateColumn: pickColumn(stored.startDateColumn),
    endDateColumn: pickColumn(stored.endDateColumn),
    groupColumn: typeof stored.groupColumn === 'string' && fkNames.has(stored.groupColumn) ? stored.groupColumn : null,
    laneColorColumn: pickRelatedColumn(stored.laneColorColumn),
    laneOrderColumn: pickRelatedColumn(stored.laneOrderColumn),
    progressColumn: pickColumn(stored.progressColumn),
    titleFormula: pickFormula(stored.titleFormula) ?? (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null),
    descriptionFormula: pickFormula(stored.descriptionFormula),
    colorFormula: pickFormula(stored.colorFormula),
    defaultColor: stored.defaultColor === null ? null : typeof stored.defaultColor === 'string' ? stored.defaultColor as RoleColor : DEFAULT_GANTT_BAR_COLOR,
    laneOrder,
    defaultZoom: typeof stored.defaultZoom === 'string' && GANTT_ZOOMS.includes(stored.defaultZoom as GanttZoom) ? stored.defaultZoom as GanttZoom : 'day'
  }
}
/**
 * `view_config.tree_layout` (TREE, DataViews.md §5.14): `parentColumn` is the table's foreign key to
 * itself - the server fills it in and refuses a column that isn't one; `orderColumn` a number column ordering
 * siblings (renumbered when one is dragged), none = by title. The formulas are CARDS'/MAP's; `expandLevel` how many
 * levels open on load.
 */
export type TreeDisplay = 'tree' | 'org'
export interface TreeLayoutConfig {
  parentColumn: string | null
  orderColumn: string | null
  titleFormula: string | null
  descriptionFormula: string | null
  iconFormula: string | null
  colorFormula: string | null
  imageFormula: string | null
  defaultDisplay: TreeDisplay
  expandLevel: number
}
export function resolveTreeLayout(viewConfig: Record<string, unknown>, columns: DataViewField[]): TreeLayoutConfig {
  const stored = (viewConfig.tree_layout as Partial<TreeLayoutConfig> | undefined) ?? {}
  const names = new Set(columns.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => f.columnName))
  const pickColumn = (value: unknown): string | null => typeof value === 'string' && names.has(value) ? value : null
  const pickFormula = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const firstVisibleColumn = columns.find(f => f.kind === 'COLUMN' && f.visible && f.columnName && f.columnName !== stored.parentColumn)?.columnName
  return {
    parentColumn: pickColumn(stored.parentColumn),
    orderColumn: pickColumn(stored.orderColumn),
    titleFormula: pickFormula(stored.titleFormula) ?? (firstVisibleColumn ? `{{${firstVisibleColumn}}}` : null),
    descriptionFormula: pickFormula(stored.descriptionFormula),
    iconFormula: pickFormula(stored.iconFormula),
    colorFormula: pickFormula(stored.colorFormula),
    imageFormula: pickFormula(stored.imageFormula),
    defaultDisplay: stored.defaultDisplay === 'org' ? 'org' : 'tree',
    expandLevel: typeof stored.expandLevel === 'number' && stored.expandLevel >= 0 && stored.expandLevel <= 20 ? stored.expandLevel : 1
  }
}

/** Same fixed trailing-lane key role `KANBAN_UNASSIGNED_KEY` plays for KANBAN - only meaningful when `GanttLayoutConfig.groupColumn` is set (DataViewGanttView.vue's lanes). */
export const GANTT_UNASSIGNED_KEY = '__unassigned__'

/** `POST /dataviews/:id/sync-fields`'s response - mirrors packages/dataviews' own `SyncFieldsResult`. See DataViewsAdminService.syncFields()'s doc comment for what each list means (new/renamed/orphaned columns - the Design form's schema-drift fix). */
export interface SyncFieldsResult {
  added: DataViewField[]
  renamed: { fieldId: string, from: string, to: string }[]
  orphaned: DataViewField[]
}

/** PATCH /dataviews/:id body - identity fields only (DataViewsAdminService.update()'s own limitation for this delivery step; source/columns/features are create-time-only until the Design form exists). */
/** PATCH /admin/api/dataviews/{id} - sent as `{ data: UpdateDataViewBody }`. */
export interface UpdateDataViewBody {
  name?: string
  slug?: string
  description?: string | null
  menuLabel?: string | null
  icon?: string | null
  color?: string | null
  /** Shallow-merged server-side into the stored view_config - never a full replace, see DataViewsAdminService.update()'s own doc comment. */
  viewConfig?: Record<string, unknown>
  /** The "Show in the App menu" switch. */
  scope?: DataViewScope
  /** A list DataView's main view - one of its `layouts` (DataViews.md §5.13). */
  viewType?: DataViewType
}

/** One row of `totalbase.dataviews_versions` - Foundations.md §13. `version` only ever increases; `restoredFromVersion` is set only when this version came from restoring an older one. */
export interface DataViewPublish {
  id: string
  dataview: string
  version: number
  restoredFromVersion: number | null
  user: string | null
  publishedAt: string
  note: string | null
}

/** `GET /dataviews/:id/versions/:version` - one version, shaped like the published read path so it renders as users saw it. */
export interface DataViewVersionSnapshot extends Omit<DataViewPublish, 'dataview'> {
  dataview: DataView
  fields: DataViewField[]
}

/** POST /admin/api/dataviews - sent as `{ data: CreateDataViewBody }`. */
export interface CreateDataViewBody {
  name: string
  slug?: string
  description?: string | null
  icon?: string | null
  color?: string | null
  /** Omitted for EXTERNALFRAME, the one layout with no source. */
  sourceResourceId?: string
  viewType: DataViewType
  /** Wizard step 4 - column names to include as visible fields; omitted means "all columns" (service default). */
  selectedColumns?: string[]
  /** Wizard step 5 - `{ features: { [key]: boolean } }`, keyed by the chosen type's DATAVIEW_FEATURES. */
  viewConfig?: Record<string, unknown>
  /** Wizard step 4's per-column help/widget overrides, keyed by column name - only columns the builder actually touched need an entry. */
  fieldOverrides?: Record<string, { widget?: string, help?: string }>
  /** MASTER_DETAIL only - the detail table and its FK column pointing at the master (GET /dataviews/detail-candidates). */
  detail?: {
    resourceId: string
    fkColumn: string
    /** The detail rows' columns - its grid and each row's form (the wizard's Detail columns step). */
    selectedColumns?: string[]
    fieldOverrides?: Record<string, { widget?: string, help?: string }>
  }
}

/** A table whose FK points at a MASTER_DETAIL DataView's master - the wizard's Detail step. */
export interface DetailCandidate {
  resourceId: string
  schema: string
  table: string
  /** The detail table's column that references the master. */
  fkColumn: string
}

/** Which tab of the DataView designer (pages/dataviews/[id]/design.vue) is showing - the canvas, the page's variables, or its code. */
export type DesignerView = 'design' | 'variables' | 'code'
/** The designer's tabs, in the page header (a phone: above the body). */
export const DESIGNER_VIEWS: { label: string, value: DesignerView, icon: string }[] = [
  { label: 'Design', value: 'design', icon: 'i-lucide-layout-panel-left' },
  { label: 'Variables', value: 'variables', icon: 'i-lucide-variable' },
  { label: 'Code', value: 'code', icon: 'i-lucide-code' }
]

/** A column's visibility and position in a viewer's grid prefs / a saved view. */
/** A viewer's column (DataViews.md §5.9): shown, its place and, set from its header, how its text fits and aligns and its width (px, dragged) - over the DataView's. */
export type ColPref = { visible: boolean, order: number, textWrap?: GridCellTextWrap, align?: CellAlign, width?: number }
export type Density = 'normal' | 'compact' | 'tiny'
/**
 * A table's row density - only UTable's own td/th padding and font size,
 * never row content. Normal is the theme's own table, untouched; the others
 * only override padding/size, merged over the theme's classes
 * (tailwind-merge), so color and weight stay Nuxt UI's. A grid's density
 * switcher, and any compact table (a variable's records), read it.
 */
export const DENSITY_META: Record<Density, { label: string, td?: string, th?: string }> = {
  normal: { label: 'Normal' },
  compact: { label: 'Compact', td: 'h-[34px]', th: 'h-[34px]' },
  tiny: { label: 'Very compact', td: 'h-[24px] px-3 py-0.5 text-xs', th: 'h-[28px] px-3 py-1 text-xs' }
}

/** What a saved view (and view_config.default_state) captures - opaque to the server. */
export interface SavedViewConfig {
  where?: Record<string, unknown> | null
  columnPrefs?: Record<string, ColPref>
  sort?: string
  density?: Density
  /** Which of the DataView's views (DataViews.md §5.13) it opens in. */
  layout?: DataViewType
}

/** One of GET /dataviews/:id/saved-views - `isOwner`: the caller may edit/delete/share it, not only apply it. */
export interface SavedView {
  id: string
  name: string
  config: SavedViewConfig
  isOwner: boolean
  sharedCount: number
  /** Who shared it - null on the caller's own. */
  ownerName: string | null
}

/** Who a saved view is shared with - a role or a user. */
export interface SavedViewRecipient {
  kind: 'USER' | 'ROLE'
  id: string
  name: string | null
  email: string | null
}

/** Two states are the same view - what "modified" compares (key order and unset vs. null don't count). */
export function sameSavedViewConfig(a: SavedViewConfig, b: SavedViewConfig): boolean {
  const norm = (c: SavedViewConfig) => JSON.stringify({
    where: c.where && Object.keys(c.where).length > 0 ? c.where : null,
    sort: c.sort || null,
    density: c.density ?? null,
    layout: c.layout ?? null,
    columns: Object.entries(c.columnPrefs ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([key, pref]) => [key, pref.visible, pref.order])
  })
  return norm(a) === norm(b)
}

/** A DataView's icon: its author's, else its type's - as the App menu shows it. */
export function dataviewIcon(dataview: Pick<DataView, 'icon' | 'viewType'>): string {
  return dataview.icon || DATAVIEW_TYPE_META[dataview.viewType].icon
}

/**
 * `view_config.settings_layout` (SETTINGS DataViews, DataViews.md §5.12): which columns hold each
 * setting's key, value, title and description (required) and, optionally, its group and its order - and the
 * heuristic telling a parameter table, shared with the MCP (@totalbase/tb-catalog settings-layout.ts).
 */
export type SettingsLayoutConfig = SettingsLayout
export { looksLikeSettingsTable, REQUIRED_SETTINGS_LAYOUT_KEYS, SETTINGS_LAYOUT_KEYS, suggestSettingsLayout }
export function resolveSettingsLayout(viewConfig: Record<string, unknown>): SettingsLayoutConfig {
  const stored = (viewConfig.settings_layout ?? {}) as Partial<Record<string, unknown>>
  const pick = (key: string) => (typeof stored[key] === 'string' && stored[key] ? stored[key] as string : null)
  return { keyColumn: pick('keyColumn'), valueColumn: pick('valueColumn'), titleColumn: pick('titleColumn'), descriptionColumn: pick('descriptionColumn'), groupColumn: pick('groupColumn'), orderColumn: pick('orderColumn') }
}
export function settingsLayoutComplete(layout: SettingsLayoutConfig): boolean {
  return REQUIRED_SETTINGS_LAYOUT_KEYS.every(key => Boolean(layout[key]))
}

/** `view_config.header_align` (a TABLE's, DataViews.md §5.2): every column title so aligned - null (Automatic): each as its column. */
export type HeaderAlign = 'left' | 'center' | 'right'
export function resolveHeaderAlign(viewConfig: Record<string, unknown> | null | undefined): HeaderAlign | null {
  const stored = viewConfig?.header_align
  return stored === 'left' || stored === 'center' || stored === 'right' ? stored : null
}

/**
 * `view_config.list_margin` (TABLE, CARDS, KANBAN, CALENDAR, GANTT, MAP - DataViews.md §5): the space
 * around the list's content. Null: a TABLE's the instance's (Settings > DataViews > Table margin - none by default,
 * the grid under the header); any other list's normal - cards and maps keep their margin.
 */
export type ListMargin = 'none' | 'compact' | 'normal'
export const LIST_MARGIN_META: Record<ListMargin, { label: string }> = {
  none: { label: 'No margin' },
  compact: { label: 'Compact' },
  normal: { label: 'Normal' }
}
/** Written out in full, for Tailwind - `normal` is PageShell's own body padding. */
export const LIST_MARGIN_CLASS: Record<ListMargin, string> = {
  none: '',
  compact: 'p-2 sm:p-3',
  normal: 'p-4 sm:p-6'
}
export function storedListMargin(viewConfig: Record<string, unknown>): ListMargin | null {
  const stored = viewConfig.list_margin
  return stored === 'none' || stored === 'compact' || stored === 'normal' ? stored : null
}
export function resolveListMargin(dataview: Pick<DataView, 'viewType' | 'viewConfig' | 'instancePageLayout'>): ListMargin {
  const own = storedListMargin(dataview.viewConfig ?? {})
  if (own) return own
  return dataview.viewType === 'TABLE' ? dataview.instancePageLayout?.tableMargin ?? 'normal' : 'normal'
}

/**
 * The list types (DataViews.md §5) - a list DataView may offer several of them as its views. In their
 * canonical order - from what serves any table to what needs a special column - the wizard's and the Views
 * accordion's.
 */
export const LIST_DATAVIEW_TYPES: DataViewType[] = ['TABLE', 'CARDS', 'KANBAN', 'CALENDAR', 'GANTT', 'MAP', 'TREE']
/**
 * `view_config.layouts` - the views a list DataView offers, in order; its viewType (the one it opens with) is
 * always among them. Empty or unset: viewType alone.
 */
export function resolveLayouts(dataview: Pick<DataView, 'viewType' | 'viewConfig'>): DataViewType[] {
  if (!LIST_DATAVIEW_TYPES.includes(dataview.viewType)) return [dataview.viewType]
  const stored = Array.isArray(dataview.viewConfig?.layouts) ? (dataview.viewConfig.layouts as unknown[]) : []
  const layouts = stored.filter((v): v is DataViewType => typeof v === 'string' && LIST_DATAVIEW_TYPES.includes(v as DataViewType))
  return layouts.includes(dataview.viewType) ? [...new Set(layouts)] : [dataview.viewType, ...new Set(layouts)]
}
