<script setup lang="ts">
/**
 * `TDataView` (Specification_DataViews.md §9.7) - the one widget that embeds
 * another published DataView in a page: its grid, cards, map, board, calendar
 * or timeline, its New and its record form for editing and deleting. Its
 * viewers' permissions decide what they read and write; `readOnly` turns
 * writing off here.
 *
 * With `column` (Linked by), the rows that belong to the page's record - an
 * order's items, a person's history: only those whose column points at it, a
 * new row starts linked to it, and nothing shows until the record is saved
 * (never every row instead). Without, every row its own filter allows.
 *
 * Here, not in the DataView: which of its views shows (`view`, one it offers),
 * what a viewer may do besides reading (`allow` - only less than their
 * permissions), the toolbar (`toolbarMode` - none keeps New alone) and each of
 * its functions (`tools`, EMBED_TOOL_DEFAULTS - each can only turn one off),
 * which columns show (`columns` - their format stays the DataView's), New's
 * label, paging. It tells the page what changed (`{ action, rows }` - a trigger
 * may have recomputed the record: Rows changed reloads it), and which row was
 * clicked or opened.
 */
import { resolveAutoRefresh, resolveBaseWhere, resolveCalendarLayout, resolveCardLayout, resolveDefaultState, resolveFeatures, resolveGanttLayout, resolveKanbanLayout, resolveTreeLayout, resolveLayouts, resolveMapLayout, resolveMapView, DATAVIEW_TYPE_META, type DataViewField, type DataViewType, type RowsChange } from '~/types/dataview'
import { EMBED_TOOL_DEFAULTS } from '@totalbase/tb-catalog'
import { WIDGET_RUNTIME_KEY } from '~/composables/useWidgetRuntime'

const props = withDefaults(defineProps<{
  /** The embedded DataView's id. */
  dataview?: string
  /** Its table's column pointing at the page's record - optional. */
  column?: string
  /** One of the views it offers - unset: the one it opens with. */
  view?: DataViewType
  /** What a viewer may do besides reading - unset: create, update and delete (their permissions still decide). */
  allow?: ('create' | 'update' | 'delete')[]
  toolbarMode?: 'none' | 'compact' | 'full'
  /** Its toolbar's functions on or off - over EMBED_TOOL_DEFAULTS. */
  tools?: Record<string, boolean>
  /** The columns shown - unset: as the DataView shows them. */
  columns?: string[]
  newLabel?: string
  paging?: boolean
  /** Linked by a column: its rows edited in the grid and saved with the page's record (Specification_DataViews.md §6.6). */
  editInline?: boolean
  readOnly?: boolean
}>(), {
  dataview: undefined,
  column: undefined,
  view: undefined,
  allow: undefined,
  toolbarMode: 'compact',
  tools: undefined,
  columns: undefined,
  newLabel: undefined,
  paging: true,
  editInline: false,
  readOnly: false
})
const emit = defineEmits<{
  /** Rows were created, edited, deleted or imported here - which, and those rows. */
  rowsChanged: [change: RowsChange]
  /** A row was clicked. */
  rowSelected: [row: Record<string, unknown>]
  /** A row's record form opened. */
  rowOpened: [row: Record<string, unknown>]
}>()

const runtime = inject(WIDGET_RUNTIME_KEY)!
const { t } = useI18n()
const live = runtime.mode === 'live'
const record = runtime.record
/** The page listens to Row selected: a click reaches it even where the row doesn't open. */
const listensToSelect = !!getCurrentInstance()?.vnode.props?.onRowSelected

const { dataview, fields: ownFields, loadFailed, loading, primaryKey, canWrite: baseCanWrite, canCreate: baseCanCreate, canDelete: baseCanDelete, editPresentation, editSize, editSide }
  = useLinkedDataview(live ? props.dataview ?? null : null)

// On the canvas: which DataView it shows, by name and type.
const adminApi = useAdminApi()
const { data: designTarget } = useAsyncData(`embed-dataview-${props.dataview ?? 'none'}`,
  () => (!live && props.dataview ? adminApi.get<{ name: string, viewType: keyof typeof DATAVIEW_TYPE_META }>(`/dataviews/${props.dataview}`).then(r => r.data) : Promise.resolve(null)),
  { default: () => null })

const recordKey = computed(() => {
  const pk = record?.pk
  return pk === null || pk === undefined || pk === '' ? null : pk
})
/** Linked by a column: nothing until the page has a saved record - never every row instead; edited in the grid, a new record's lines save with it. */
const missing = computed(() => {
  if (!props.column) return null
  if (!record) return { title: t('dataviews.widgetDataView.noRecordTitle'), description: t('dataviews.widgetDataView.noRecordDescription') }
  if (recordKey.value === null && !(inline.value && record.mode === 'create')) return { title: t('dataviews.widgetDataView.saveFirstTitle'), description: t('dataviews.widgetDataView.saveFirstDescription') }
  return null
})

const viewConfig = computed(() => dataview.value?.viewConfig ?? {})
/** The view it shows: `view` when the DataView offers it, else the one it opens with. */
const viewType = computed<DataViewType>(() => {
  if (!dataview.value) return 'TABLE'
  return props.view && resolveLayouts(dataview.value).includes(props.view) ? props.view : dataview.value.viewType
})
/** `columns`: those shown here, the rest hidden - with the DataView's format; the grid keeps their order over the viewer's prefs (`fixed-columns`). */
const fields = computed<DataViewField[]>(() => {
  const shown = props.columns?.filter(Boolean) ?? []
  if (shown.length === 0) return ownFields.value
  return ownFields.value.map(field => ((field.kind === 'COLUMN' || field.kind === 'RELATED') && field.columnName
    ? { ...field, visible: shown.includes(field.columnName) }
    : field))
})
/** Its own base filter AND, when linked, the record's rows. */
const forcedWhere = computed(() => {
  const base = resolveBaseWhere(viewConfig.value) ?? {}
  const scope = props.column && recordKey.value !== null ? { [props.column]: { _eq: String(recordKey.value) } } : {}
  if (Object.keys(scope).length === 0) return base
  return Object.keys(base).length > 0 ? { _and: [base, scope] } : scope
})
const createDefaults = computed(() => (props.column && recordKey.value !== null ? { [props.column]: recordKey.value } : undefined))
/** Each action: allowed here, not Read only, the page's record not in view mode - and the viewer's own permission. */
const allows = (action: 'create' | 'update' | 'delete') => !props.readOnly && record?.mode !== 'view' && (!props.allow || props.allow.includes(action))
const canWrite = computed(() => allows('update') && baseCanWrite.value)
const canCreate = computed(() => allows('create') && baseCanCreate.value)
const canDelete = computed(() => allows('delete') && baseCanDelete.value)
/** Edited in the grid: linked to the page's record and something to write here - read only, the grid as always. */
const inline = computed(() => props.editInline && !!props.column && !!record && (canWrite.value || canCreate.value || canDelete.value))
const features = computed(() => (dataview.value ? resolveFeatures(viewType.value, viewConfig.value) : {}))
/** Its toolbar's functions here - each can only turn one of the DataView's own off; no toolbar, none of them. */
const tools = computed<Record<string, boolean>>(() => {
  const on = props.toolbarMode !== 'none'
  return Object.fromEntries(Object.entries(EMBED_TOOL_DEFAULTS).map(([key, start]) => [key, on && (props.tools?.[key] ?? start)]))
})
/** A row opens over the page - never navigating away from it. */
const recordPresentation = computed(() => (editPresentation.value === 'PAGE' ? 'MODAL' : editPresentation.value))
const recordSize = computed(() => (editPresentation.value === 'PAGE' ? 'xl' : editSize.value))
</script>

<template>
  <div
    v-if="!live"
    class="flex h-full min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-accented bg-elevated/50 p-3 text-center"
  >
    <UIcon
      :name="designTarget ? DATAVIEW_TYPE_META[designTarget.viewType].icon : 'i-lucide-panels-top-left'"
      class="size-5 text-muted"
    />
    <p class="text-sm font-medium text-highlighted">
      {{ designTarget ? t('dataviews.widgetDataView.titleNamed', { name: designTarget.name }) : t('dataviews.widgetDataView.title') }}
    </p>
    <p class="text-xs text-muted">
      {{ !props.dataview ? t('dataviews.widgetDataView.pickDataView') : column ? (readOnly ? t('dataviews.widgetDataView.linkedRowsReadOnly', { column }) : t('dataviews.widgetDataView.linkedRows', { column })) : (readOnly ? t('dataviews.widgetDataView.everyRowReadOnly') : t('dataviews.widgetDataView.everyRow')) }}
    </p>
  </div>
  <UEmpty
    v-else-if="missing"
    icon="i-lucide-panels-top-left"
    :title="missing.title"
    :description="missing.description"
    variant="naked"
  />
  <UEmpty
    v-else-if="loading"
    loading
    variant="naked"
    size="sm"
  />
  <UEmpty
    v-else-if="loadFailed || !dataview?.sourceResourceSchema || !dataview.sourceResourceName"
    icon="i-lucide-eye-off"
    :title="t('dataviews.widgetDataView.notAvailableTitle')"
    :description="t('dataviews.widgetDataView.notAvailableDescription')"
    variant="naked"
  />
  <!-- A div holds it, so the size the page gives this widget lands on an element. -->
  <div
    v-else
    class="h-full w-full"
  >
    <DataViewInlineLines
      v-if="inline"
      :record="record!"
      :dataview-id="dataview.id"
      :schema="dataview.sourceResourceSchema"
      :table="dataview.sourceResourceName"
      :fields="fields"
      :primary-key="primaryKey ?? null"
      :column="column!"
      :record-key="recordKey"
      :forced-where="forcedWhere"
      :order-by="typeof resolveDefaultState(viewConfig).sort === 'string' ? resolveDefaultState(viewConfig).sort as string : undefined"
      :can-create="canCreate"
      :can-write="canWrite"
      :can-delete="canDelete"
      :new-label="newLabel === 'Add item' ? t('dataviews.grid.addItem') : newLabel"
    />
    <Suspense v-else>
      <DataViewGrid
        class="h-full w-full"
        :view-type="viewType"
        :card-layout="resolveCardLayout(viewConfig, fields)"
        :map-layout="resolveMapLayout(viewConfig, fields)"
        :map-view="resolveMapView(viewConfig)"
        :kanban-layout="resolveKanbanLayout(viewConfig, fields)"
        :calendar-layout="resolveCalendarLayout(viewConfig, fields)"
        :gantt-layout="resolveGanttLayout(viewConfig, fields)"
        :tree-layout="resolveTreeLayout(viewConfig, fields)"
        :dataview="dataview"
        :dataview-id="dataview.id"
        :dataview-slug="dataview.slug"
        :schema="dataview.sourceResourceSchema"
        :resource-name="dataview.sourceResourceName"
        :fields="fields"
        :dataview-title="dataview.name ?? ''"
        :dataview-description="dataview.description ?? ''"
        :can-write="canWrite"
        :can-create="canCreate"
        :can-delete="canDelete"
        :primary-key="primaryKey"
        :features="features"
        :feature-mask="tools"
        :embed-toolbar="toolbarMode"
        :clickable-rows="listensToSelect"
        :fixed-columns="columns?.length ? columns : undefined"
        :new-label="newLabel === 'Add item' ? t('dataviews.grid.addItem') : newLabel"
        :pin-row-actions="!!column"
        :paging="paging"
        :edit-presentation="recordPresentation"
        :edit-size="recordSize"
        :edit-side="editSide"
        :create-defaults="createDefaults"
        :forced-where="forcedWhere"
        :source-resource-oid="dataview.sourceResourceOid ?? undefined"
        :source-resource-type="dataview.sourceResourceType ?? undefined"
        :source-resource-id="dataview.sourceResource"
        :show-refresh="tools.refresh && features.refresh !== false"
        :refresh-interval="tools.autoRefresh ? resolveAutoRefresh(viewConfig) : null"
        :default-state="resolveDefaultState(viewConfig)"
        fill-height
        @rows-changed="(change: RowsChange) => emit('rowsChanged', change)"
        @row-selected="(row: Record<string, unknown>) => emit('rowSelected', row)"
        @row-opened="(row: Record<string, unknown>) => emit('rowOpened', row)"
      />
      <template #fallback>
        <UEmpty
          loading
          variant="naked"
          size="sm"
        />
      </template>
    </Suspense>
  </div>
</template>
