<script setup lang="ts">
/**
 * The generic inspector for a widget placed on a canvas (DataViews.md §9, §12.6):
 * Props · Events, read from the widget
 * catalog (`WIDGET_CATALOG`, @totalbase/tb-catalog) instead of written per
 * control type. Every prop gets the editor the catalog names; a `formula`
 * prop gets a Bind button, a data prop (`modelValue`, `items`, `data`) a
 * variable selector.
 *
 * Everything arrives through props and the `v-model` config - the designer
 * hosting it owns saving, the variables and the Code - so any DataView
 * type's Design form mounts the same inspector. The host adds its own
 * actions beside the header (`#actions`) and its fields at the top of
 * Props (`#identity`).
 */
import {
  authorPattern,
  COMMON_STYLE_PROPS,
  commonWidgetProps,
  WIDGET_COLORS,
  variableKindForProp,
  widgetDefinition,
  type ColumnPresentation,
  type TableAction,
  type TableColumnSettings,
  type TableComputedColumn,
  type WidgetControlConfig,
  type WidgetItem,
  type WidgetProp,
  type WidgetPropBinding,
  type VariableKind,
  type VariableRef, PROP_SECTIONS } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import type { JunctionCandidate } from '~/utils/junction-links'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import DesignerClassListEditor from '~/components/DesignerClassListEditor.vue'
import TableActionsEditor from '~/components/TableActionsEditor.vue'
import TableComputedColumnsEditor from '~/components/TableComputedColumnsEditor.vue'
import WidgetItemsEditor from '~/components/WidgetItemsEditor.vue'
import { sanitizeHtmlAttrs } from '~/utils/field-config'
import type { HtmlAttrRow } from '~/utils/field-config'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

const config = defineModel<WidgetControlConfig>({ required: true })
const { t } = useI18n()
const cat = useDesignerCatalogText()
const props = defineProps<{
  /** The page's variables, for data bindings. */
  variables?: readonly VariableRef[]
  /** The Code's function names, for events. */
  codeFunctions?: readonly string[]
  /** Offered in the Bind modal's Fields section (a record's columns). */
  columns?: CatalogColumn[]
  relations?: RelationDefinition[]
  /** The page's record table - what a Detail's linking column points at. */
  recordTable?: { schema: string, name: string } | null
  /** The record table's junction tables - a form field's Junction table. */
  junctions?: readonly JunctionCandidate[]
  /** The page's DataView - whose roles an embedded Dashboard's warning checks. */
  dataviewId?: string
  /** A Resource variable's fields, in order - a Table's Columns. */
  resourceFields?: (variable: string) => string[] | undefined
  /** A Resource variable's columns, name → PostgreSQL type - which options each Table column offers. */
  resourceColumns?: (variable: string) => Record<string, string> | undefined
  /** What a Resource variable's resource columns set - what a Table's columns inherit. */
  resourcePresentation?: (variable: string) => Record<string, ColumnPresentation> | undefined
  /** What a record column's presentation sets - what a form field bound to it inherits. */
  recordPresentation?: (column: string) => ColumnPresentation | undefined
  /** Where that presentation is edited (Database), for a column - a full href (it opens in a new tab). */
  presentationLink?: (column: string) => string | undefined
  /** The record's resource - a form field's column's presentation, shown read only in From the column and edited over the page. */
  presentationResource?: string
  /**
   * Its own props only - no header, tabs, Advanced or Events: a dashboard's presentation widget (D3), which has none
   * of the page's common props or Code, mounted inside the dashboard's own inspector.
   */
  bare?: boolean
}>()
// --- The sections with lookups of their own are children, one instance per prop: an embedded DataView
// (WidgetInspectorEmbedField.vue), an embedded Dashboard (WidgetInspectorDashboardField.vue), an image
// (WidgetInspectorImageField.vue). Each loads what its own prop needs, and only the latest answer lands.
const EMBED_EDITORS = ['dataview', 'detailColumn', 'dataviewView', 'dataviewColumns', 'dataviewTools', 'dataviewAllow']

/** A Table's (and an option list's) fields from the Resource its Rows are bound to (useInspectorTable). */
const { boundColumns, fieldItems, unknownField, boundFieldColumns, computedColumns, tableColumnList, rowFieldColumns, boundInherited, boundVariable } = useInspectorTable({
  config,
  resourceFields: () => props.resourceFields,
  resourceColumns: () => props.resourceColumns,
  resourcePresentation: () => props.resourcePresentation
})
/** A column prop's choices: the record's columns, with their type. */
const columnItems = computed(() => (props.columns ?? []).map(c => ({ label: c.name, description: c.dataType, value: c.name })))
/** A junction prop's choices: the record table's junction tables, each with the table it links to. */
const junctionItems = computed(() => (props.junctions ?? []).map(j => ({ label: j.table, description: t('designer.inspector.junctionLinks', { table: j.target.table }), value: j.resourceId })))
const emit = defineEmits<{
  /** "Create handler": the host scaffolds a function in the Code, sets it on the event and shows it. */
  createHandler: [event: string]
  /** Shows an event's function in the Code. */
  openHandler: [name: string]
  /** A prop that names a Code function (a form's Validate) - or one of its items' (a menu item's): the host scaffolds it and sets it. */
  createFunction: [prop: string, item?: number]
  /** "+ New variable" beside a data prop: the host opens the variable form, then binds it. */
  newVariable: [kind: VariableKind, prop: string]
  /** A select's Search window turned on: the host has its options' Resource read every column of its table - its columns. */
  widenResource: [variable: string]
  /** A form field's column's presentation saved in the table - the host reads it again. */
  presentationSaved: []
}>()

const entry = computed(() => {
  const name = config.value.widget
  const definition = widgetDefinition(name)
  return { ...definition, label: cat.widgetLabel(name, definition.label), description: cat.widgetDescription(name, definition.description) }
})
/** A catalog prop with its label and description in the UI's language. */
function translated([name, prop]: [string, WidgetProp]): [string, WidgetProp] {
  const widget = config.value.widget
  return [name, {
    ...prop,
    label: cat.propLabel(widget, name, prop.label),
    description: prop.description === undefined ? undefined : cat.propDescription(widget, name, prop.description)
  }]
}
/**
 * Props: the component's own - those without a section first, then each
 * section the catalog declares (`WidgetProp.section`, PROP_SECTIONS) under
 * its rule, in the order they appear -, then TotalBase's common ones
 * (Visible, HTML attributes, Read only, Fill height) under Advanced. Style:
 * the box's spacing, border, background, shadow and alignment
 * (COMMON_STYLE_PROPS), then its CSS classes.
 */
const propSections = computed(() => {
  // Style draws its own controls (below the identity slot), not the props list.
  if (tab.value === 'style') return []
  const own = Object.entries(entry.value.props)
  const sectioned = [...new Set(own.flatMap(([, prop]) => (prop.section ? [prop.section] : [])))]
  const common = Object.entries(commonWidgetProps(config.value.widget)).filter(([name]) => !(name in COMMON_STYLE_PROPS) && name !== 'cssClass')
  return [
    { title: null, entries: own.filter(([, prop]) => !prop.section).map(translated) },
    ...sectioned.map(section => ({ title: cat.propSectionLabel(section, PROP_SECTIONS[section]), entries: own.filter(([, prop]) => prop.section === section).map(translated) })),
    ...(props.bare ? [] : [{ title: t('designer.inspector.advanced'), entries: common.map(translated) }])
  ]
})
const emitEntries = computed(() => Object.entries(entry.value.emits)
  .map(([name, emitEntry]) => [name, { ...emitEntry, label: cat.emitLabel(config.value.widget, name, emitEntry.label) }] as const))

const tab = ref('props')
const tabs = computed(() => [
  { label: t('designer.inspector.tabs.props'), value: 'props' },
  { label: t('designer.inspector.tabs.style'), value: 'style', badge: styleKeys.value.length || undefined },
  { label: t('designer.inspector.tabs.events'), value: 'events', badge: Object.keys(config.value.emits).length || undefined },
  // A form field bound to a column: the column's presentation, read only (DataViews.md §15.4).
  ...(fieldColumn.value && props.presentationResource ? [{ label: t('designer.inspector.tabs.column'), value: 'column' }] : [])
])

// --- Props -----------------------------------------------------------------

/** `record` without `key`, or with it set to `value`. */
function withKey<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  const next = Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
  if (value !== undefined) next[key] = value
  return next
}

function setProp(name: string, value: unknown) {
  let next = withKey(config.value.props, name, value === '' ? undefined : value)
  // A form field edits a column or a junction's links, never both.
  if (config.value.widget === 'UFormField' && value && (name === 'column' || name === 'junction')) next = withKey(next, name === 'column' ? 'junction' : 'column', undefined)
  config.value = { ...config.value, props: next }
  if (name === 'searchWindow' && value === true && boundVariable.value) emit('widenResource', boundVariable.value)
}

// --- A form field bound to a column: its texts inherit the column's presentation (DataViews.md §15).
// Three states - inherited (unset), its own, none ("": shown nowhere, the column untouched).
const INHERITABLE_TEXTS = ['label', 'description', 'hint', 'help'] as const
const fieldColumn = computed(() => (config.value.widget === 'UFormField' && typeof config.value.props.column === 'string' ? config.value.props.column : null))
function inheritable(name: string): boolean {
  return !!fieldColumn.value && (INHERITABLE_TEXTS as readonly string[]).includes(name)
}
/** What the column gives the field: its presentation's text - a label falls back to the name humanized; a hint, nothing. */
function inheritedText(name: string): string {
  if (!fieldColumn.value) return ''
  const presentation = props.recordPresentation?.(fieldColumn.value)
  if (name === 'label') return presentation?.label ?? humanizeColumnName(fieldColumn.value)
  if (name === 'description') return presentation?.description ?? ''
  if (name === 'help') return presentation?.help ?? ''
  return ''
}
function textState(name: string): 'inherited' | 'own' | 'none' {
  const value = config.value.props[name]
  return value === '' ? 'none' : typeof value === 'string' ? 'own' : 'inherited'
}
/** None stores "" - setProp would clear it back to inherited. */
function toggleNone(name: string) {
  config.value = { ...config.value, props: withKey(config.value.props, name, textState(name) === 'none' ? undefined : '') }
}
const columnPresentationLink = computed(() => (fieldColumn.value ? props.presentationLink?.(fieldColumn.value) : undefined))
/** Its own text, the same as the column's - nothing of its own to keep (T78): "Use the column's" drops it. */
function sameAsColumn(name: string): boolean {
  return textState(name) === 'own' && stringProp(name) === inheritedText(name)
}
/** Edit in the table: the column's panel over the page. */
const editingColumn = ref(false)
/** The Style props this widget has set - its spacing, alignment, colors and CSS classes. */
const styleKeys = computed(() => [...Object.keys(COMMON_STYLE_PROPS), 'cssClass'].filter(name => config.value.props[name] !== undefined))
/** Style's Reset: every one of them cleared at once, in one change. */
function resetStyle() {
  const props = Object.fromEntries(Object.entries(config.value.props).filter(([name]) => !styleKeys.value.includes(name)))
  config.value = { ...config.value, props }
}
/** A switch: unset means the prop's default (Visible is on); the default itself is never stored. */
function booleanProp(name: string, prop: WidgetProp): boolean {
  return (config.value.props[name] ?? prop.default ?? false) === true
}
function setBoolean(name: string, prop: WidgetProp, value: boolean) {
  setProp(name, value === (prop.default ?? false) ? undefined : value)
}

/** HTML attributes as editable rows; reserved names (class, on*, ...) are dropped when stored. */
const attrRows = ref<Record<string, HtmlAttrRow[]>>({})
function rowsOf(name: string): HtmlAttrRow[] {
  return attrRows.value[name] ?? []
}
// The rows editor changes its rows in place - stored as they change.
watch(attrRows, (all) => {
  for (const [name, rows] of Object.entries(all)) {
    const attrs = sanitizeHtmlAttrs(rows)
    const next = Object.keys(attrs).length ? attrs : undefined
    if (JSON.stringify(next) !== JSON.stringify(config.value.props[name])) setProp(name, next)
  }
}, { deep: true })
function stringProp(name: string): string | undefined {
  const value = config.value.props[name]
  return typeof value === 'string' ? value : undefined
}
function numberProp(name: string): number | undefined {
  const value = config.value.props[name]
  return typeof value === 'number' ? value : undefined
}

function setBinding(name: string, binding: WidgetPropBinding | null) {
  config.value = { ...config.value, bindings: withKey(config.value.bindings, name, binding ?? undefined) }
}

function formulaOf(name: string): string {
  const binding = config.value.bindings[name]
  return binding?.kind === 'formula' ? binding.formula : ''
}
function setFormula(name: string, formula: string) {
  setBinding(name, formula.trim() ? { kind: 'formula', formula } : null)
}

/** The Bind modal's kind: rich text only where the prop renders text. */
function bindKind(prop: WidgetProp): 'text' | 'boolean' | 'value' {
  if (prop.editor === 'boolean') return 'boolean'
  if (prop.editor === 'text' || prop.editor === 'textarea') return 'text'
  return 'value'
}

/** The editors that show a formula binding beside their own control (the generic field and the icon picker). */
function bindsBesideControl(prop: WidgetProp): boolean {
  return !variableKindForProp(prop) && !['dataview', 'detailColumn', 'dataviewView', 'dataviewColumns', 'dataviewTools', 'dataviewAllow', 'dashboard', 'dashboardVariables', 'column', 'junction', 'function', 'items', 'computedColumns'].includes(prop.editor)
}

/** An input's Value: a Value variable, or a formula - `{{controls.selectCliente.item.cuit}}` - shown read only. */
function computesValue(name: string, prop: WidgetProp): boolean {
  return name === 'modelValue' && prop.binding === 'value' && widgetDefinition(config.value.widget).group === 'input'
}

/** Reka's select can't hold an empty value. */
const NONE = '__none__'
function variableItems(kind: VariableKind) {
  return [
    { label: t('common.none'), value: NONE },
    ...(props.variables ?? []).filter(v => v.kind === kind).map(v => ({ label: v.name, value: v.name }))
  ]
}
function variableOf(name: string): string {
  const binding = config.value.bindings[name]
  return binding?.kind === 'variable' ? binding.variable : NONE
}
function setVariable(name: string, variable: string) {
  setBinding(name, variable === NONE ? null : { kind: 'variable', variable })
}

/** `json` props are edited as text and stored parsed; invalid JSON stays in the field, unsaved, with an error. */
const jsonDrafts = ref<Record<string, string>>({})
const jsonErrors = ref<Record<string, boolean>>({})
function jsonText(name: string): string {
  if (name in jsonDrafts.value) return jsonDrafts.value[name]!
  const value = config.value.props[name]
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}
function commitJson(name: string) {
  const text = jsonDrafts.value[name]
  if (text === undefined) return
  try {
    setProp(name, text.trim() ? JSON.parse(text) : undefined)
    jsonDrafts.value = withKey(jsonDrafts.value, name, undefined)
    jsonErrors.value = { ...jsonErrors.value, [name]: false }
  } catch {
    jsonErrors.value = { ...jsonErrors.value, [name]: true }
  }
}
/** `regex` props likewise: saved only when the pattern compiles (the server refuses one that doesn't); otherwise it stays here with an error. */
const regexDrafts = ref<Record<string, string>>({})
const regexErrors = ref<Record<string, boolean>>({})
function commitRegex(name: string) {
  const text = regexDrafts.value[name]
  if (text === undefined) return
  if (text.trim() && !authorPattern(text)) {
    regexErrors.value = { ...regexErrors.value, [name]: true }
    return
  }
  setProp(name, text.trim() ? text : undefined)
  regexDrafts.value = withKey(regexDrafts.value, name, undefined)
  regexErrors.value = { ...regexErrors.value, [name]: false }
}
watch(() => config.value.widget, () => {
  jsonDrafts.value = {}
  jsonErrors.value = {}
  regexDrafts.value = {}
  regexErrors.value = {}
}, { immediate: true })
// Seeded from the stored attributes whenever another widget is inspected.
watch(() => config.value.widget, () => {
  const rows: Record<string, HtmlAttrRow[]> = {}
  for (const [name, prop] of Object.entries(commonWidgetProps(config.value.widget))) {
    if (prop.editor !== 'attributes') continue
    const stored = (config.value.props[name] ?? {}) as Record<string, string>
    rows[name] = Object.entries(stored).map(([key, value]) => ({ key, value }))
  }
  attrRows.value = rows
}, { immediate: true })

// --- Events (WidgetInspectorEventsTab.vue) ----------------------------------

function setHandler(event: string, handler: string | undefined) {
  config.value = { ...config.value, emits: withKey(config.value.emits, event, handler) }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- What the widget is, and what acts on it (the host's "⋮"). -->
    <div
      v-if="!bare"
      class="flex items-start gap-2"
    >
      <UIcon
        :name="entry.icon"
        class="size-4 mt-0.5 shrink-0 text-muted"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">
          {{ entry.label }}
        </p>
        <p class="text-xs text-muted">
          {{ entry.description }}
        </p>
      </div>
      <slot name="actions" />
    </div>
    <UTabs
      v-if="!bare"
      v-model="tab"
      :items="tabs"
      :content="false"
      size="xs"
    />

    <!-- From the column: a form field's column's presentation, read only - edited in the table. -->
    <ColumnPresentationSummary
      v-if="tab === 'column' && fieldColumn && presentationResource"
      :key="fieldColumn"
      :resource-id="presentationResource"
      :column-name="fieldColumn"
      :presentation="recordPresentation?.(fieldColumn) ?? {}"
      @saved="emit('presentationSaved')"
    />
    <!-- Props: the host's fields about this placement first (the designer's Name, a form field's Input), then the catalog's props. -->
    <div
      v-else-if="tab !== 'events'"
      class="flex flex-col gap-3"
    >
      <slot
        v-if="tab === 'props'"
        name="identity"
      />
      <!-- Style, as design tools lay it out: spacing as a box model, alignment as icons, colors as swatches. -->
      <template v-if="tab === 'style'">
        <WidgetStyleFields
          :values="config.props"
          :applied="styleKeys.length"
          @set="setProp"
          @reset="resetStyle"
        />
      </template>
      <template
        v-for="section in propSections"
        :key="section.title ?? 'props'"
      >
        <USeparator
          v-if="section.title"
          :label="section.title"
        />
        <div
          v-for="[name, prop] in section.entries"
          :key="name"
          class="flex items-start gap-2"
        >
          <div class="flex-1 min-w-0">
            <!-- A data prop: bound to a variable of its kind, never a literal. -->
            <UFormField
              v-if="variableKindForProp(prop)"
              :label="prop.label"
              :description="prop.description ?? t('designer.inspector.variableOfKind', { kind: variableKindForProp(prop) })"
            >
              <div class="flex gap-1">
                <USelect
                  :model-value="variableOf(name)"
                  :items="variableItems(variableKindForProp(prop)!)"
                  class="flex-1 min-w-0"
                  @update:model-value="setVariable(name, $event)"
                />
                <UButton
                  icon="i-lucide-plus"
                  color="neutral"
                  variant="outline"
                  :aria-label="t('designer.inspector.newVariableOfKind', { kind: variableKindForProp(prop) })"
                  @click="emit('newVariable', variableKindForProp(prop)!, name)"
                />
                <!-- An input's Value may be a formula instead: a computed input, read only (DataViews.md §9.2). -->
                <BindingButton
                  v-if="computesValue(name, prop)"
                  :model-value="formulaOf(name)"
                  kind="value"
                  :label="t('designer.inspector.computedReadOnly', { label: prop.label })"
                  :columns="columns"
                  :relations="relations"
                  beside-input
                  @update:model-value="setFormula(name, $event)"
                />
              </div>
            </UFormField>

            <!-- Its own title and help text - no form field around it. -->
            <DesignerHtmlAttrsEditor
              v-else-if="prop.editor === 'attributes'"
              :model-value="rowsOf(name)"
            />

            <!-- An embedded DataView: which one, its linking column, its view, its columns, its tools and what it allows. -->
            <WidgetInspectorEmbedField
              v-else-if="EMBED_EDITORS.includes(prop.editor)"
              :name="name"
              :prop="prop"
              :config="config"
              :record-table="recordTable"
              @set="setProp"
            />

            <!-- An embedded Dashboard, and its variables set from the page. -->
            <WidgetInspectorDashboardField
              v-else-if="prop.editor === 'dashboard' || prop.editor === 'dashboardVariables'"
              :name="name"
              :prop="prop"
              :config="config"
              :dataview-id="dataviewId"
              @set="setProp"
            />

            <!-- A field of the Resource its options come from - picked, not typed; an option list's may be a formula per option instead. -->
            <UFormField
              v-else-if="prop.editor === 'resourceField'"
              :label="prop.label"
              :description="boundColumns.length ? prop.description : t('designer.inspector.bindOptionsFirst', { description: prop.description })"
              :error="unknownField(name)"
            >
              <div class="flex items-center gap-1">
                <USelectMenu
                  v-if="boundColumns.length"
                  :model-value="stringProp(name)"
                  :items="fieldItems"
                  value-key="value"
                  clear
                  class="min-w-0 flex-1"
                  :aria-label="prop.label"
                  @update:model-value="setProp(name, $event || undefined)"
                />
                <UInput
                  v-else
                  :model-value="stringProp(name) ?? ''"
                  class="min-w-0 flex-1"
                  :aria-label="prop.label"
                  @update:model-value="setProp(name, $event || undefined)"
                />
                <BindingButton
                  v-if="prop.binding === 'option'"
                  :model-value="formulaOf(name)"
                  :kind="name === 'disabledKey' ? 'boolean' : 'text'"
                  :label="config.widget === 'UTable' ? t('designer.inspector.perRow', { label: prop.label }) : t('designer.inspector.perOption', { label: prop.label })"
                  :columns="rowFieldColumns"
                  beside-input
                  @update:model-value="setFormula(name, $event)"
                />
              </div>
            </UFormField>

            <!-- Some of its Rows' fields, in the order they are chosen. -->
            <UFormField
              v-else-if="prop.editor === 'tableColumns'"
              :label="prop.label"
              :description="boundColumns.length ? prop.description : t('designer.inspector.bindRowsFirst')"
            >
              <TableColumnsEditor
                :model-value="(config.props[name] as Record<string, TableColumnSettings> | undefined)"
                :columns="tableColumnList"
                :inherited="boundInherited"
                :default-title="(column: string) => computedColumns.find(c => c.key === column)?.label ?? humanizeColumnName(column)"
                :formula-columns="rowFieldColumns"
                @update:model-value="setProp(name, $event)"
              />
            </UFormField>

            <!-- Its computed columns: a formula per row each. -->
            <UFormField
              v-else-if="prop.editor === 'computedColumns' && !boundColumns.length"
              :label="prop.label"
              :description="t('designer.inspector.bindRowsFirst')"
            />
            <TableComputedColumnsEditor
              v-else-if="prop.editor === 'computedColumns'"
              :model-value="(config.props[name] as TableComputedColumn[] | undefined)"
              :label="prop.label"
              :description="prop.description"
              :columns="boundFieldColumns"
              @update:model-value="setProp(name, $event)"
            />

            <!-- Its Row actions: icon buttons, each with its Name. -->
            <TableActionsEditor
              v-else-if="prop.editor === 'actions'"
              :model-value="(config.props[name] as TableAction[] | undefined)"
              :label="prop.label"
              :description="prop.description"
              :columns="boundColumns.length ? rowFieldColumns : undefined"
              @update:model-value="setProp(name, $event)"
            />

            <!-- A Tabs', an Accordion's or a Dropdown menu's items, each with its formulas. -->
            <WidgetItemsEditor
              v-else-if="prop.editor === 'items'"
              :model-value="(config.props[name] as WidgetItem[] | undefined)"
              :label="prop.label"
              :description="prop.description"
              :fields="prop.itemFields ?? []"
              :key-prefix="config.widget === 'UTabs' ? 'tab' : config.widget === 'UAccordion' ? 'section' : config.widget === 'USplitter' ? 'panel' : 'item'"
              :code-functions="codeFunctions"
              :columns="columns"
              :relations="relations"
              @update:model-value="setProp(name, $event)"
              @create-function="(item: number) => emit('createFunction', name, item)"
            />

            <!-- A column of the page's record. -->
            <UFormField
              v-else-if="prop.editor === 'column'"
              :label="prop.label"
              :description="columns?.length ? prop.description : t('designer.inspector.noRecordTableColumn')"
            >
              <USelectMenu
                :model-value="stringProp(name)"
                :items="columnItems"
                value-key="value"
                :disabled="!columns?.length"
                clear
                class="w-full"
                @update:model-value="setProp(name, $event || undefined)"
              />
            </UFormField>

            <!-- A junction table of the page's record table: the field edits its links. -->
            <UFormField
              v-else-if="prop.editor === 'junction'"
              :label="prop.label"
              :description="junctions?.length ? prop.description : t('designer.inspector.noJunction')"
            >
              <USelectMenu
                :model-value="stringProp(name)"
                :items="junctionItems"
                value-key="value"
                :disabled="!junctions?.length"
                clear
                class="w-full"
                @update:model-value="setProp(name, $event || undefined)"
              />
            </UFormField>

            <!-- A prop that names a Code function (a form's Validate). -->
            <WidgetInspectorFunctionField
              v-else-if="prop.editor === 'function'"
              :prop="prop"
              :value="stringProp(name)"
              :code-functions="codeFunctions"
              @set="setProp(name, $event)"
              @create-function="emit('createFunction', name)"
              @open-handler="emit('openHandler', $event)"
            />

            <!-- The icon at the left, its formula binding at the right edge - in line with the other fields' buttons. -->
            <div
              v-else-if="prop.editor === 'icon'"
              class="flex items-end justify-between gap-1"
            >
              <IconPickerField
                :model-value="stringProp(name)"
                :label="prop.label"
                :description="prop.description"
                options="lucide"
                clearable
                @update:model-value="setProp(name, $event)"
              />
              <BindingButton
                v-if="prop.binding === 'formula'"
                :model-value="formulaOf(name)"
                :kind="bindKind(prop)"
                :label="prop.label"
                :columns="columns"
                :relations="relations"
                beside-input
                @update:model-value="setFormula(name, $event)"
              />
            </div>

            <!-- An image: a file's id or a URL - or one uploaded here, a PUBLIC file anyone who opens the page sees. -->
            <WidgetInspectorImageField
              v-else-if="prop.editor === 'image'"
              :prop="prop"
              :value="stringProp(name)"
              :formula="formulaOf(name)"
              :columns="columns"
              :relations="relations"
              @set="setProp(name, $event)"
              @set-formula="setFormula(name, $event)"
            />

            <!-- A column-bound field's text: inherited, its own, or none. -->
            <WidgetInspectorInheritedTextField
              v-else-if="inheritable(name)"
              :name="name"
              :prop="prop"
              :value="stringProp(name)"
              :state="textState(name)"
              :inherited-text="inheritedText(name)"
              :same-as-column="sameAsColumn(name)"
              :bind-kind="bindKind(prop)"
              :formula="formulaOf(name)"
              :columns="columns"
              :relations="relations"
              :can-edit-column="!!presentationResource"
              :presentation-link="columnPresentationLink"
              @set="setProp(name, $event)"
              @toggle-none="toggleNone(name)"
              @set-formula="setFormula(name, $event)"
              @edit-column="editingColumn = true"
            />

            <UFormField
              v-else
              :label="prop.label"
              :description="prop.description"
              :error="jsonErrors[name] ? t('designer.inspector.invalidJson') : regexErrors[name] ? t('designer.inspector.invalidRegex') : undefined"
            >
              <!-- The control and, at its right, its formula binding - like Value's "+" beside its select; a switch's at the right edge, in line. -->
              <div
                class="flex gap-1"
                :class="prop.editor === 'boolean' ? 'items-center justify-between' : 'items-start'"
              >
                <div :class="prop.editor === 'boolean' ? 'flex' : 'min-w-0 flex-1'">
                  <USwitch
                    v-if="prop.editor === 'boolean'"
                    :model-value="booleanProp(name, prop)"
                    @update:model-value="setBoolean(name, prop, $event)"
                  />
                  <UInputNumber
                    v-else-if="prop.editor === 'number'"
                    :model-value="numberProp(name)"
                    class="w-full"
                    @update:model-value="setProp(name, $event ?? undefined)"
                  />
                  <USelect
                    v-else-if="prop.editor === 'select' || prop.editor === 'color'"
                    :model-value="stringProp(name) ?? NONE"
                    :items="[{ label: t('designer.inspector.default'), value: NONE }, ...(prop.editor === 'color' ? WIDGET_COLORS : prop.options ?? []).map(o => ({ label: o, value: o }))]"
                    class="w-full"
                    @update:model-value="setProp(name, $event === NONE ? undefined : $event)"
                  />
                  <UTextarea
                    v-else-if="prop.editor === 'textarea'"
                    :model-value="stringProp(name) ?? ''"
                    autoresize
                    class="w-full"
                    @update:model-value="setProp(name, $event)"
                  />
                  <UTextarea
                    v-else-if="prop.editor === 'json'"
                    :model-value="jsonText(name)"
                    :rows="3"
                    autoresize
                    class="w-full font-mono"
                    @update:model-value="jsonDrafts[name] = String($event)"
                    @blur="commitJson(name)"
                  />
                  <UInput
                    v-else-if="prop.editor === 'regex'"
                    :model-value="regexDrafts[name] ?? stringProp(name) ?? ''"
                    class="w-full font-mono"
                    @update:model-value="regexDrafts[name] = String($event)"
                    @blur="commitRegex(name)"
                    @keydown.enter="commitRegex(name)"
                  />
                  <UInput
                    v-else
                    :model-value="stringProp(name) ?? ''"
                    class="w-full"
                    @update:model-value="setProp(name, $event)"
                  />
                </div>
                <BindingButton
                  v-if="prop.binding === 'formula'"
                  :model-value="formulaOf(name)"
                  :kind="bindKind(prop)"
                  :label="prop.label"
                  :columns="columns"
                  :relations="relations"
                  beside-input
                  @update:model-value="setFormula(name, $event)"
                />
              </div>
            </UFormField>
            <p
              v-if="formulaOf(name)"
              class="mt-1 text-xs text-muted font-mono truncate"
            >
              = {{ formulaOf(name) }}
            </p>
          </div>
          <!-- The editors that don't place it beside their control. BindingButton renders a fragment (its modal) - the wrapper carries the offset. -->
          <div
            v-if="prop.binding === 'formula' && !bindsBesideControl(prop)"
            class="mt-6"
          >
            <BindingButton
              :model-value="formulaOf(name)"
              :kind="bindKind(prop)"
              :label="prop.label"
              :columns="columns"
              :relations="relations"
              @update:model-value="setFormula(name, $event)"
            />
          </div>
        </div>
      </template>
      <!-- Style's Advanced: its own Tailwind classes, one per row. -->
      <template v-if="tab === 'style'">
        <USeparator :label="t('designer.inspector.advanced')" />
        <DesignerClassListEditor
          :model-value="stringProp('cssClass')"
          @update:model-value="setProp('cssClass', $event)"
        />
      </template>
    </div>

    <!-- Events: the component's own emits, each calling a Code function. -->
    <WidgetInspectorEventsTab
      v-else
      :entries="emitEntries"
      :handlers="config.emits"
      :code-functions="codeFunctions"
      @set-handler="setHandler"
      @create-handler="emit('createHandler', $event)"
      @open-handler="emit('openHandler', $event)"
    />
    <ColumnPresentationEditor
      v-if="editingColumn && fieldColumn && presentationResource"
      v-model:open="editingColumn"
      :resource-id="presentationResource"
      :column-name="fieldColumn"
      @saved="emit('presentationSaved')"
    />
  </div>
</template>
