<script setup lang="ts">
/**
 * WidgetInspector.vue's fields for an embedded DataView (TDataView): which one
 * (`dataview`), the column linking its rows to the record (`detailColumn`),
 * the view it opens with (`dataviewView`), which of its columns show
 * (`dataviewColumns`), its toolbar functions (`dataviewTools`) and what it
 * allows besides reading (`dataviewAllow`). One instance per prop; the
 * lookups a prop needs (the DataView's columns, the linking columns) run in
 * the instance of that prop only, and only the latest answer lands.
 */
import { EMBED_ACTIONS, EMBED_TOOL_DEFAULTS, widgetDefinition, type WidgetControlConfig, type WidgetProp } from '@totalbase/tb-catalog'
import { DATAVIEW_FEATURES, DATAVIEW_TYPE_META, dataviewMetaKey, featureLabelKey, resolveLayouts, type DataViewField, type DataViewType } from '~/types/dataview'
import type { RelationDetail } from '~/types/schema'
import { useCatalogText } from '~/utils/catalog-text'

const props = defineProps<{
  name: string
  prop: WidgetProp
  /** The widget's whole config - the other embed props it reads (the chosen DataView, its view, its toolbar mode). */
  config: WidgetControlConfig
  /** The page's record table - what a Detail's linking column points at. */
  recordTable?: { schema: string, name: string } | null
}>()
const emit = defineEmits<{
  /** A prop's new value - `undefined` clears it. */
  set: [name: string, value: unknown]
}>()
const { t } = useI18n()
const catalogText = useCatalogText()
const adminApi = useAdminApi()

function stringProp(name: string): string | undefined {
  const value = props.config.props[name]
  return typeof value === 'string' ? value : undefined
}
function listProp(name: string): string[] {
  const value = props.config.props[name]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// The DataViews the sidebar already holds (useAppsNav*), not a list of this inspector's own.
const { dataviews: dataviewList } = useAppsNavDataViews()
/** What an embedded DataView may show - a list, never a page (the server's `assertEmbeddable`). */
const EMBEDDABLE_VIEW_TYPES = ['TABLE', 'CARDS', 'MAP', 'KANBAN', 'CALENDAR', 'GANTT', 'TREE']
/** Any list DataView. */
const dataviewItems = computed(() => dataviewList.value
  .filter(d => EMBEDDABLE_VIEW_TYPES.includes(d.viewType))
  .map(d => ({ label: d.name, description: `${d.sourceResourceSchema}.${d.sourceResourceName}`, value: d.id })))
const detailDataview = computed(() => {
  const id = Object.entries(widgetDefinition(props.config.widget).props).find(([, p]) => p.editor === 'dataview')?.[0]
  const value = id ? props.config.props[id] : undefined
  return dataviewList.value.find(d => d.id === value) ?? null
})

// --- dataviewView: the views the chosen DataView offers - the one it opens with first. ---
const embedViewItems = computed(() => (detailDataview.value ? resolveLayouts(detailDataview.value) : []).map(type => ({
  label: catalogText(dataviewMetaKey('types', type, 'label'), DATAVIEW_TYPE_META[type].label),
  icon: DATAVIEW_TYPE_META[type].icon,
  value: type
})))

// --- dataviewColumns: the chosen DataView's columns, in its order, and whether it shows each. ---
const latestEmbedColumns = useLatest()
const embedColumns = ref<{ name: string, visible: boolean }[]>([])
watch(detailDataview, async (dv) => {
  const load = latestEmbedColumns.next()
  embedColumns.value = []
  if (!dv || props.prop.editor !== 'dataviewColumns') return
  try {
    const { data } = await adminApi.get<DataViewField[]>(`/dataviews/${dv.id}/fields`)
    if (!load.isCurrent()) return
    embedColumns.value = data.flatMap(f => ((f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName ? [{ name: f.columnName, visible: f.visible }] : []))
  } catch {
    // Best-effort: no columns to pick.
  }
}, { immediate: true })
/** Shown here: the embed's own list, else as the DataView shows them. */
function columnShown(column: { name: string, visible: boolean }): boolean {
  const list = listProp(props.name)
  return list.length ? list.includes(column.name) : column.visible
}
function setColumnShown(column: string, on: boolean) {
  const shown = embedColumns.value.filter(c => (c.name === column ? on : columnShown(c))).map(c => c.name)
  const asOwn = embedColumns.value.every(c => shown.includes(c.name) === c.visible)
  emit('set', props.name, asOwn ? undefined : shown)
}

// --- dataviewTools: the toolbar functions the shown view has (its catalog's), plus Auto-refresh. ---
const embedToolKeys = computed(() => {
  const dv = detailDataview.value
  if (!dv) return []
  const type = (stringProp('view') as DataViewType | undefined) ?? dv.viewType
  const own = (DATAVIEW_FEATURES[type] ?? []).filter(f => f.group === 'table').map(f => f.key)
  return [...Object.keys(EMBED_TOOL_DEFAULTS).filter(key => own.includes(key)), 'autoRefresh']
})
function toolLabel(key: string): string {
  return key === 'autoRefresh'
    ? t('designer.inspector.autoRefreshTool')
    : catalogText(featureLabelKey({ key }), (DATAVIEW_FEATURES.TABLE ?? DATAVIEW_FEATURES.CARDS ?? []).find(f => f.key === key)?.label ?? key)
}
function toolOn(key: string): boolean {
  const value = props.config.props[props.name]
  const own = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof own === 'boolean' ? own : EMBED_TOOL_DEFAULTS[key] ?? true
}
function setTool(key: string, on: boolean) {
  const current = (props.config.props[props.name] && typeof props.config.props[props.name] === 'object' ? props.config.props[props.name] : {}) as Record<string, boolean>
  const next = Object.fromEntries(Object.entries({ ...current, [key]: on }).filter(([k, v]) => v !== EMBED_TOOL_DEFAULTS[k]))
  emit('set', props.name, Object.keys(next).length ? next : undefined)
}

// --- dataviewAllow: create, update, delete - unset: all three. ---
function allowed(action: string): boolean {
  const value = props.config.props[props.name]
  return Array.isArray(value) ? value.includes(action) : true
}
function setAllowed(action: string, on: boolean) {
  const next = EMBED_ACTIONS.filter(a => (a === action ? on : allowed(a)))
  emit('set', props.name, next.length === EMBED_ACTIONS.length ? undefined : next)
}

// --- detailColumn: the columns that can link its rows to the record. ---
/**
 * A table's foreign keys to the record table; a view has none of its own, so any of its columns (the one holding
 * the record's key is the author's to pick). One way to link them: that's the one.
 */
const latestLinkingColumns = useLatest()
const linkingColumns = ref<string[]>([])
watch(detailDataview, async (detail) => {
  const load = latestLinkingColumns.next()
  linkingColumns.value = []
  if (props.prop.editor !== 'detailColumn' || !detail?.sourceResource || !props.recordTable) return
  const isView = detail.sourceResourceType === 'VIEW'
  const { data } = await adminApi.get<RelationDetail>(`/catalog/${isView ? 'view' : 'table'}/${detail.sourceResource}`)
  if (!load.isCurrent()) return
  linkingColumns.value = isView
    ? data.columns.map(c => c.name)
    : data.relations
        .filter(r => r.targetSchema === props.recordTable!.schema && r.targetTable === props.recordTable!.name)
        .map(r => r.sourceColumn)
  if (!stringProp(props.name) && linkingColumns.value.length === 1) emit('set', props.name, linkingColumns.value[0])
}, { immediate: true })
</script>

<template>
  <!-- An embedded DataView. -->
  <UFormField
    v-if="prop.editor === 'dataview'"
    :label="prop.label"
    :description="prop.description"
  >
    <USelectMenu
      :model-value="stringProp(name)"
      :items="dataviewItems"
      value-key="value"
      class="w-full"
      @update:model-value="emit('set', name, $event || undefined)"
    />
  </UFormField>

  <!-- The detail table's column pointing at the record. -->
  <UFormField
    v-else-if="prop.editor === 'detailColumn'"
    :label="prop.label"
    :description="!recordTable
      ? t('designer.inspector.noRecordTable')
      : detailDataview && linkingColumns.length === 0
        ? t('designer.inspector.noLinkingColumn', { detail: detailDataview.sourceResourceName, table: recordTable.name })
        : prop.description"
  >
    <USelectMenu
      :model-value="stringProp(name)"
      :items="linkingColumns"
      :disabled="linkingColumns.length === 0"
      class="w-full"
      @update:model-value="emit('set', name, $event || undefined)"
    />
  </UFormField>

  <!-- Which of the embedded DataView's views shows. -->
  <UFormField
    v-else-if="prop.editor === 'dataviewView'"
    :label="prop.label"
    :description="detailDataview ? prop.description : t('designer.inspector.pickDataViewFirst')"
  >
    <USelectMenu
      :model-value="(stringProp(name) as DataViewType | undefined)"
      :items="embedViewItems"
      value-key="value"
      :disabled="!detailDataview"
      clear
      class="w-full"
      @update:model-value="emit('set', name, $event || undefined)"
    />
  </UFormField>

  <!-- Each of its columns, shown or hidden here. -->
  <UFormField
    v-else-if="prop.editor === 'dataviewColumns'"
    :label="prop.label"
    :description="detailDataview ? prop.description : t('designer.inspector.pickDataViewFirst')"
  >
    <div class="flex flex-col gap-1.5">
      <UCheckbox
        v-for="column in embedColumns"
        :key="column.name"
        :model-value="columnShown(column)"
        :label="column.name"
        :aria-label="column.name"
        @update:model-value="(on: boolean | 'indeterminate') => setColumnShown(column.name, on === true)"
      />
    </div>
  </UFormField>

  <!-- Each toolbar function, on or off here. -->
  <UFormField
    v-else-if="prop.editor === 'dataviewTools'"
    :label="prop.label"
    :description="detailDataview ? prop.description : t('designer.inspector.pickDataViewFirst')"
  >
    <div class="flex flex-col gap-1.5">
      <USwitch
        v-for="key in embedToolKeys"
        :key="key"
        :model-value="toolOn(key)"
        :label="toolLabel(key)"
        :aria-label="toolLabel(key)"
        :disabled="stringProp('toolbarMode') === 'none'"
        @update:model-value="(on: boolean) => setTool(key, on)"
      />
    </div>
  </UFormField>

  <!-- Create, update, delete - besides reading. -->
  <UFormField
    v-else-if="prop.editor === 'dataviewAllow'"
    :label="prop.label"
    :description="prop.description"
  >
    <div class="flex flex-wrap gap-4">
      <UCheckbox
        v-for="action in EMBED_ACTIONS"
        :key="action"
        :model-value="allowed(action)"
        :label="t(`designer.inspector.allow.${action}`)"
        :aria-label="t(`designer.inspector.allow.${action}`)"
        @update:model-value="(on: boolean | 'indeterminate') => setAllowed(action, on === true)"
      />
    </div>
  </UFormField>
</template>
