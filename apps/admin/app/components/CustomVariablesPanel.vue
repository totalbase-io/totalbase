<script setup lang="ts">
/**
 * A CUSTOM page's Variables tab (Specification_DataViews.md §12):
 * the list on the left, grouped by kind, and the selected variable's form on
 * the right - built from the variable catalog (`VARIABLE_CATALOG`,
 * @totalbase/tb-catalog): its kind's props, its events with a Code function
 * each, and who uses it.
 *
 * Edits the `v-model` list; the designer saves it (and the server validates
 * it with the same catalog). Renaming emits `rename` so the designer can
 * update the widgets bound to the old name.
 */
import {
  CREATABLE_VARIABLE_KINDS,
  isValidValue,
  VALUE_TYPE_META,
  VALUE_TYPES,
  VARIABLE_CATALOG,
  variableKindDefinition,
  type CallTarget,
  type CallVariableDefinition,
  type ResourceVariableDefinition,
  type TableCallAction,
  type ValueDefault,
  type ValueType,
  type ValueVariableDefinition,
  type VariableDefinition,
  type VariableKind
} from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { DataApiMethod } from '~/types/resource'
import type { RelationDetail } from '~/types/schema'
import QueryBuilder from '~/components/QueryBuilder.vue'
import { withoutVariables } from '~/utils/data-api-query'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

const variables = defineModel<VariableDefinition[]>({ required: true })
const selectedName = defineModel<string | null>('selected', { default: null })
/** The page's record settings (`view_config.record`): its events' functions. */
const record = defineModel<{ emits?: Record<string, string> } | undefined>('record')
const props = defineProps<{
  /** The record's table (`schema.name`), when the page has one - listed as the `record` variable. */
  recordTable?: string | null
  /** The Code's function names, for events. */
  codeFunctions: readonly string[]
  /** Each variable's users: widget names and the Code functions that mention it. */
  usedBy: (name: string) => string[]
  /** A Resource the roles opening the page may not fully read - why, for its warning (Specification_DataViews.md §8.3, "All or nothing"). */
  accessWarning?: (name: string) => string | undefined
}>()
const emit = defineEmits<{
  /** "Create handler" for `event` of `variable` - the designer scaffolds it and answers with its name. */
  createHandler: [variable: string, event: string, done: (name: string) => void]
  /** Shows an event's function in the Code. */
  openHandler: [name: string]
  rename: [from: string, to: string]
}>()

const adminApi = useAdminApi()
const dataApi = useDataApi()
const toast = useToast()
const { t } = useI18n()
const cat = useDesignerCatalogText()
const kindLabel = (kind: VariableKind) => cat.variableKindLabel(kind, VARIABLE_CATALOG[kind].label)
const resourceProp = (prop: keyof typeof VARIABLE_CATALOG.RESOURCE.props) => VARIABLE_CATALOG.RESOURCE.props[prop] as { label: string, description?: string }
const resourcePropLabel = (prop: keyof typeof VARIABLE_CATALOG.RESOURCE.props) => cat.variablePropLabel('RESOURCE', prop, resourceProp(prop).label)
const resourcePropDescription = (prop: keyof typeof VARIABLE_CATALOG.RESOURCE.props) => cat.variablePropDescription('RESOURCE', prop, resourceProp(prop).description)
const { resources } = useResourcesList()

const selected = computed(() => variables.value.find(v => v.name === selectedName.value) ?? null)
/** The record is listed as `record` - a reserved name, so no variable takes it. */
const RECORD = 'record'
const RECORD_FORMULA = '{{vars.record.data.column}}'
const recordSelected = computed(() => Boolean(props.recordTable) && selectedName.value === RECORD)
/** One list, by name - the name is what code and formulas use; each kind shows in its icon. */
const sortedVariables = computed(() => [...variables.value].sort((a, b) => a.name.localeCompare(b.name)))
/** A search over the names - shown once there are many. */
const SEARCH_FROM = 20
const search = ref('')
/** Values, Resources and Calls, each by name, with how many - an empty group isn't shown. */
const groups = computed(() => {
  const query = search.value.trim().toLowerCase()
  return (['VALUE', 'RESOURCE', 'CALL'] as const)
    .map(kind => ({ kind, items: sortedVariables.value.filter(v => v.kind === kind && (!query || v.name.toLowerCase().includes(query))) }))
    .filter(group => group.items.length > 0)
})
const collapsedGroups = ref(new Set<string>())
function toggleGroup(kind: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  collapsedGroups.value = next
}
// A variable picked elsewhere (a widget's binding): its group opens.
watch(selectedName, (name) => {
  const kind = variables.value.find(v => v.name === name)?.kind
  if (kind && collapsedGroups.value.has(kind)) toggleGroup(kind)
})

function replace(next: VariableDefinition) {
  variables.value = variables.value.map(v => (v.name === selected.value?.name ? next : v))
}

// --- New / delete / rename ---------------------------------------------------

function uniqueName(base: string): string {
  let name = base
  for (let i = 2; variables.value.some(v => v.name === name); i++) name = `${base}${i}`
  return name
}

/** A new variable of `kind` with its catalog's defaults - also used by "+ New variable" on a widget prop. */
function create(kind: Exclude<VariableKind, 'RECORD'>): string {
  const name = uniqueName(kind === 'VALUE' ? 'value' : kind === 'RESOURCE' ? 'rows' : 'action')
  const definition: VariableDefinition = kind === 'VALUE'
    ? { name, kind, type: 'text' }
    : kind === 'RESOURCE'
      ? { name, kind, resource: '', query: { fields: '' }, mode: 'list', immediate: true, watch: true, count: false }
      : { name, kind, target: { type: 'WORKFLOW', slug: '' } }
  variables.value = [...variables.value, definition]
  selectedName.value = name
  return name
}
defineExpose({ create })

const newItems = computed(() => CREATABLE_VARIABLE_KINDS.map(kind => ({
  label: kindLabel(kind),
  description: cat.variableKindDescription(kind, VARIABLE_CATALOG[kind].description),
  icon: VARIABLE_CATALOG[kind].icon,
  onSelect: () => {
    create(kind as Exclude<VariableKind, 'RECORD'>)
  }
})))

function remove() {
  if (!selected.value) return
  const users = props.usedBy(selected.value.name)
  if (users.length && !window.confirm(t('designer.variablesPanel.confirmDelete', { name: selected.value.name, users: users.join(', ') }))) return
  variables.value = variables.value.filter(v => v.name !== selected.value!.name)
  selectedName.value = variables.value[0]?.name ?? null
}

const nameDraft = ref('')
watch(selectedName, name => (nameDraft.value = name ?? ''), { immediate: true })
function commitName() {
  const from = selected.value?.name
  const to = nameDraft.value.trim()
  if (!from || !to || to === from) return
  if (variables.value.some(v => v.name === to)) {
    toast.add({ title: t('designer.variablesPanel.nameTaken', { name: to }), color: 'error' })
    nameDraft.value = from
    return
  }
  replace({ ...selected.value!, name: to })
  selectedName.value = to
  emit('rename', from, to)
}

// --- Value ---------------------------------------------------------------------

const value = computed(() => selected.value?.kind === 'VALUE' ? selected.value : null)
const DEFAULT_SOURCES = computed(() => [
  { label: t('common.none'), value: 'none' },
  { label: t('designer.variablesPanel.defaultSources.constant'), value: 'constant' },
  { label: t('designer.variablesPanel.defaultSources.formula'), value: 'formula' },
  { label: t('designer.variablesPanel.defaultSources.param'), value: 'param' },
  { label: t('designer.variablesPanel.defaultSources.user'), value: 'user' }
])
const valueTypeLabel = (type: ValueType) => cat.valueTypeLabel(type, VALUE_TYPE_META[type].label)
const valueTypeItems = computed(() => VALUE_TYPES.map(type => ({ label: valueTypeLabel(type), description: cat.valueTypeDescription(type, VALUE_TYPE_META[type].description), value: type })))

function setValue(patch: Partial<ValueVariableDefinition>) {
  replace({ ...value.value!, ...patch })
}
function setDefaultSource(source: string) {
  if (source === 'none') return setValue({ default: undefined })
  const defaults: Record<string, ValueDefault> = {
    constant: { source: 'constant', value: null },
    formula: { source: 'formula', formula: '' },
    param: { source: 'param', name: value.value!.name },
    user: { source: 'user', field: 'id' }
  }
  setValue({ default: defaults[source] })
}
/** A constant default is edited as text: JSON for structured types, the text itself otherwise. */
const constantText = computed(() => {
  const def = value.value?.default
  if (def?.source !== 'constant' || def.value === null) return ''
  return typeof def.value === 'string' ? def.value : JSON.stringify(def.value)
})
const constantError = ref<string | null>(null)
function setConstant(text: string, type: ValueType) {
  let parsed: unknown = text
  if (text.trim() === '') parsed = null
  else if (type !== 'text' && type !== 'date' && type !== 'time' && type !== 'timestamp') {
    try {
      parsed = JSON.parse(text)
    } catch {
      constantError.value = t('designer.variablesPanel.invalidJson')
      return
    }
  }
  if (!isValidValue(type, parsed)) {
    constantError.value = t('designer.variablesPanel.invalidValue', { type: valueTypeLabel(type).toLowerCase() })
    return
  }
  constantError.value = null
  setValue({ default: { source: 'constant', value: parsed } })
}

// --- Resource ------------------------------------------------------------------

const resource = computed(() => selected.value?.kind === 'RESOURCE' ? selected.value : null)
const readableResources = computed(() => resources.value
  .filter(r => (r.type === 'TABLE' || r.type === 'VIEW') && r.status === 'ACTIVE' && r.exposedMethods.includes('GET'))
  .map(r => ({ label: `${r.schema}.${r.name}`, description: r.description ?? undefined, value: r.id })))
function setResource(patch: Partial<ResourceVariableDefinition>) {
  replace({ ...resource.value!, ...patch })
}

/** The chosen resource's columns, for the query builder. */
const columns = ref<CatalogColumn[]>([])
watch(() => resource.value?.resource, async (id) => {
  columns.value = []
  const target = resources.value.find(r => r.id === id)
  if (!target) return
  const { data } = await adminApi.get<RelationDetail>(`/catalog/${target.type === 'VIEW' ? 'view' : 'table'}/${target.postgresOid}`)
  columns.value = data.columns
}, { immediate: true })

const queryText = ref('')
watch(() => resource.value?.name, () => {
  queryText.value = resource.value ? JSON.stringify(resource.value.query, null, 2) : ''
}, { immediate: true })
watch(queryText, (text) => {
  if (!resource.value) return
  try {
    const parsed = JSON.parse(text || '{}') as ResourceVariableDefinition['query']
    if (JSON.stringify(parsed) !== JSON.stringify(resource.value.query)) setResource({ query: parsed })
  } catch {
    // QueryBuilder shows the parse error itself.
  }
})

/**
 * Show records (QueryRecordsModal): the query as written, with the
 * author's permissions. In the Design form no variable has a value: the
 * conditions reading one are left out, every other part kept
 * (withoutVariables).
 */
const recordsOpen = ref(false)
const recordsPath = computed(() => {
  const target = resources.value.find(r => r.id === resource.value?.resource)
  return target ? dataApi.resourcePath(target.schema, target.name, target.type === 'VIEW' ? 'view' : 'table') : null
})
const recordsQuery = computed(() => withoutVariables((resource.value?.query ?? {}) as Record<string, unknown>))
const recordsNotes = computed(() => {
  const query = (resource.value?.query ?? {}) as Record<string, unknown>
  return [
    ...(typeof query.limit !== 'number' ? [t('designer.variablesPanel.notes.noLimit')] : []),
    ...(JSON.stringify(recordsQuery.value) !== JSON.stringify(query) ? [t('designer.variablesPanel.notes.variablesLeftOut')] : [])
  ]
})
watch(selectedName, () => (recordsOpen.value = false))

// --- Call ----------------------------------------------------------------------

const call = computed(() => selected.value?.kind === 'CALL' ? selected.value : null)
const functions = computed(() => resources.value
  .filter(r => r.type === 'FUNCTION' && r.status === 'ACTIVE' && r.exposedMethods.includes('POST'))
  .map(r => ({ label: `${r.schema}.${r.name}`, description: r.description ?? undefined, value: r.id })))
/** A table Call's action - the Data API method its table must be exposed for. */
const TABLE_ACTIONS = computed<{ label: string, value: TableCallAction, method: DataApiMethod }[]>(() => [
  { label: t('designer.variablesPanel.tableActions.create'), value: 'CREATE', method: 'POST' },
  { label: t('designer.variablesPanel.tableActions.update'), value: 'UPDATE', method: 'PATCH' },
  { label: t('designer.variablesPanel.tableActions.delete'), value: 'DELETE', method: 'DELETE' }
])
const writableTables = computed(() => {
  const target = call.value?.target
  const method = TABLE_ACTIONS.value.find(a => target?.type === 'TABLE' && a.value === target.action)?.method ?? 'POST'
  return resources.value
    .filter(r => r.type === 'TABLE' && r.status === 'ACTIVE' && r.exposedMethods.includes(method))
    .map(r => ({ label: `${r.schema}.${r.name}`, description: r.description ?? undefined, value: r.id }))
})
const CALL_TYPES = computed(() => [
  { label: t('designer.variablesPanel.callTypes.workflow'), value: 'WORKFLOW' },
  { label: t('designer.variablesPanel.callTypes.function'), value: 'FUNCTION' },
  { label: t('designer.variablesPanel.callTypes.table'), value: 'TABLE' }
])
function setCallType(type: string) {
  const target: CallTarget = type === 'WORKFLOW'
    ? { type: 'WORKFLOW', slug: '' }
    : type === 'TABLE' ? { type: 'TABLE', resource: '', action: 'CREATE' } : { type: 'FUNCTION', resource: '' }
  setCall({ target })
}
interface WorkflowOption { name: string, description: string | null, slug: string, triggerType?: string | null }
const { data: workflowList } = useAsyncData('custom-variables-workflows',
  () => adminApi.get<WorkflowOption[]>('/workflows').then(r => r.data), { default: () => [] })
const manualWorkflows = computed(() => workflowList.value
  .filter(w => w.triggerType === 'MANUAL')
  .map(w => ({ label: w.name, description: w.description ?? undefined, value: w.slug })))
function setCall(patch: Partial<CallVariableDefinition>) {
  replace({ ...call.value!, ...patch })
}
/** The code in Input's description - not translated. */
const INPUT_EXAMPLES = { body: '{ "data": { ... } }', pk: '"pk"', where: '"where"', formula: '{{vars.name.value}}', code: 'dataview.vars.name.execute(body)' }
const inputText = ref('')
const inputError = ref<string | null>(null)
watch(() => call.value?.name, () => {
  inputText.value = call.value?.input ? JSON.stringify(call.value.input, null, 2) : ''
  inputError.value = null
}, { immediate: true })
function commitInput() {
  if (!call.value) return
  try {
    const parsed = inputText.value.trim() ? JSON.parse(inputText.value) : undefined
    if (parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null)) throw new Error()
    inputError.value = null
    setCall({ input: parsed })
  } catch {
    inputError.value = t('designer.variablesPanel.inputError', { example: '{ "data": { "cliente": "{{vars.cliente.value}}" } }' })
  }
}

// --- Emits ---------------------------------------------------------------------

const NONE = '__none__'
const functionItems = computed(() => [{ label: t('common.none'), value: NONE }, ...props.codeFunctions.map(name => ({ label: name, value: name }))])
/** The events of the selected variable - or of the record. */
const emitEntries = computed(() => {
  const kind: VariableKind | null = recordSelected.value ? 'RECORD' : selected.value?.kind ?? null
  if (!kind) return []
  return Object.entries(variableKindDefinition(kind).emits)
    .map(([event, meta]) => [event, { ...meta, label: cat.variableEmitLabel(kind, event, meta.label) }] as const)
})
function handlerOf(event: string): string {
  return (recordSelected.value ? record.value?.emits?.[event] : selected.value?.emits?.[event]) ?? NONE
}
function setHandler(event: string, handler: string) {
  const current = recordSelected.value ? record.value?.emits : selected.value?.emits
  const emits = Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== event))
  if (handler !== NONE) emits[event] = handler
  const next = Object.keys(emits).length ? emits : undefined
  if (recordSelected.value) record.value = { ...record.value, emits: next }
  else if (selected.value) replace({ ...selected.value, emits: next } as VariableDefinition)
}
function createHandler(event: string) {
  const owner = recordSelected.value ? RECORD : selected.value?.name
  if (owner) emit('createHandler', owner, event, name => setHandler(event, name))
}
</script>

<template>
  <div class="flex min-h-0 flex-1 gap-4">
    <!-- List, grouped by kind -->
    <div class="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-default pr-3">
      <!-- A little wider than its button: each kind's description wraps onto two or three lines. -->
      <UDropdownMenu
        :items="newItems"
        :ui="{ content: 'w-72', itemDescription: 'whitespace-normal' }"
        :content="{ align: 'start' }"
      >
        <UButton
          :label="t('designer.variablesPanel.newVariable')"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          block
        />
      </UDropdownMenu>
      <!-- The record: reserved - always there, never created or deleted - above the page's own variables. -->
      <template v-if="recordTable">
        <button
          type="button"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
          :class="recordSelected ? 'bg-elevated text-highlighted' : 'hover:bg-elevated/50'"
          @click="selectedName = RECORD"
        >
          <UIcon
            :name="VARIABLE_CATALOG.RECORD.icon"
            class="size-4 shrink-0 text-muted"
          />
          <span class="min-w-0 flex-1 truncate font-mono">record</span>
          <span class="truncate text-xs text-muted">{{ recordTable }}</span>
        </button>
        <USeparator />
      </template>
      <UInput
        v-if="sortedVariables.length > SEARCH_FROM"
        v-model="search"
        :aria-label="t('designer.variablesPanel.search')"
        icon="i-lucide-search"
        :placeholder="t('designer.variablesPanel.search')"
        size="sm"
      />
      <div
        v-for="group in groups"
        :key="group.kind"
        class="flex flex-col gap-1"
      >
        <UButton
          :label="`${kindLabel(group.kind)} (${group.items.length})`"
          :trailing-icon="collapsedGroups.has(group.kind) && !search ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          color="neutral"
          variant="link"
          size="xs"
          class="justify-between px-2 font-semibold uppercase tracking-wide text-muted"
          :aria-expanded="!collapsedGroups.has(group.kind) || !!search"
          @click="toggleGroup(group.kind)"
        />
        <template v-if="!collapsedGroups.has(group.kind) || search">
          <button
            v-for="item in group.items"
            :key="item.name"
            type="button"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            :class="[item.name === selectedName ? 'bg-elevated text-highlighted' : 'hover:bg-elevated/50', usedBy(item.name).length === 0 ? 'opacity-60' : undefined]"
            :title="usedBy(item.name).length === 0 ? t('designer.variablesPanel.unusedHint') : undefined"
            @click="selectedName = item.name"
          >
            <UTooltip :text="kindLabel(item.kind)">
              <UIcon
                :name="VARIABLE_CATALOG[item.kind].icon"
                class="size-4 shrink-0 text-muted"
              />
            </UTooltip>
            <span class="min-w-0 flex-1 truncate font-mono">{{ item.name }}</span>
            <UTooltip
              v-if="accessWarning?.(item.name)"
              :text="accessWarning(item.name)"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-4 shrink-0 text-warning"
              />
            </UTooltip>
            <!-- How many widgets use it - worth knowing before deleting it; none, it's faded. -->
            <span class="text-xs text-muted">{{ usedBy(item.name).length || '' }}</span>
          </button>
        </template>
      </div>
      <p
        v-if="sortedVariables.length === 0"
        class="px-2 text-xs text-muted"
      >
        {{ t('designer.variablesPanel.noVariables') }}
      </p>
    </div>

    <!-- The selected variable -->
    <div class="min-w-0 flex-1 overflow-y-auto pr-2">
      <UEmpty
        v-if="!selected && !recordSelected"
        icon="i-lucide-variable"
        :title="t('designer.variablesPanel.noneSelected.title')"
        :description="t('designer.variablesPanel.noneSelected.description')"
        variant="naked"
      />
      <div
        v-else
        class="flex max-w-2xl flex-col gap-4"
      >
        <!-- The record: a row of the page's table, there because the page has one. -->
        <template v-if="recordSelected">
          <div class="flex items-center gap-2">
            <UIcon
              :name="VARIABLE_CATALOG.RECORD.icon"
              class="size-5 text-muted"
            />
            <p class="text-sm font-medium">
              {{ kindLabel('RECORD') }} · <span class="font-mono">{{ recordTable }}</span>
            </p>
          </div>
          <p class="text-sm text-muted">
            {{ cat.variableKindDescription('RECORD', VARIABLE_CATALOG.RECORD.description) }} {{ t('designer.variablesPanel.recordHelp', { formula: RECORD_FORMULA }) }}
          </p>
        </template>
        <template v-if="selected">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UIcon
                :name="variableKindDefinition(selected.kind).icon"
                class="size-5 text-muted"
              />
              <p class="text-sm font-medium">
                {{ kindLabel(selected.kind) }}
              </p>
            </div>
            <UButton
              :label="t('common.delete')"
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              @click="remove"
            />
          </div>

          <UFormField
            :label="t('common.name')"
            :description="t('designer.variablesPanel.nameDescription', { code: 'dataview.vars.name', formula: '{{vars.name}}' })"
          >
            <UInput
              v-model="nameDraft"
              class="w-full font-mono"
              @blur="commitName"
              @keydown.enter="commitName"
            />
          </UFormField>

          <!-- VALUE -->
          <template v-if="value">
            <UFormField :label="cat.variablePropLabel('VALUE', 'type', VARIABLE_CATALOG.VALUE.props.type.label)">
              <USelectMenu
                :model-value="value.type"
                :items="valueTypeItems"
                value-key="value"
                class="w-full"
                @update:model-value="(type: ValueType) => setValue({ type, default: undefined })"
              />
            </UFormField>
            <UFormField
              :label="cat.variablePropLabel('VALUE', 'default', VARIABLE_CATALOG.VALUE.props.default.label)"
              :description="t('designer.variablesPanel.defaultDescription')"
            >
              <div class="flex flex-col gap-2">
                <USelect
                  :model-value="value.default?.source ?? 'none'"
                  :items="DEFAULT_SOURCES"
                  class="w-full"
                  @update:model-value="setDefaultSource"
                />
                <UInput
                  v-if="value.default?.source === 'constant'"
                  :model-value="constantText"
                  class="w-full font-mono"
                  :aria-label="t('designer.variablesPanel.defaultValue')"
                  @change="(e: Event) => setConstant((e.target as HTMLInputElement).value, value!.type)"
                />
                <p
                  v-if="constantError"
                  class="text-xs text-error"
                >
                  {{ constantError }}
                </p>
                <UInput
                  v-if="value.default?.source === 'formula'"
                  :model-value="value.default.formula"
                  class="w-full font-mono"
                  :aria-label="t('designer.variablesPanel.defaultFormula')"
                  @update:model-value="(formula: string) => setValue({ default: { source: 'formula', formula } })"
                />
                <UInput
                  v-if="value.default?.source === 'param'"
                  :model-value="value.default.name"
                  class="w-full font-mono"
                  :aria-label="t('designer.variablesPanel.defaultSources.param')"
                  @update:model-value="(name: string) => setValue({ default: { source: 'param', name } })"
                />
                <UInput
                  v-if="value.default?.source === 'user'"
                  :model-value="value.default.field"
                  class="w-full font-mono"
                  :aria-label="t('designer.variablesPanel.userField')"
                  @update:model-value="(field: string) => setValue({ default: { source: 'user', field } })"
                />
              </div>
            </UFormField>
          </template>

          <!-- RESOURCE -->
          <template v-if="resource">
            <UFormField
              :label="resourcePropLabel('resource')"
              :description="resourcePropDescription('resource')"
            >
              <USelectMenu
                :model-value="resource.resource || undefined"
                :items="readableResources"
                value-key="value"
                class="w-full"
                @update:model-value="(id: string) => setResource({ resource: id })"
              />
            </UFormField>
            <QueryBuilder
              v-model="queryText"
              :label="resourcePropLabel('query')"
              :description="resourcePropDescription('query') + ' ' + t('designer.variablesPanel.queryValues', { formula: '{{vars.name.value}}' })"
              :columns="columns"
            />
            <UFormField
              :label="resourcePropLabel('mode')"
              :description="resourcePropDescription('mode')"
            >
              <USelect
                :model-value="resource.mode"
                :items="[{ label: t('designer.variablesPanel.modes.list'), value: 'list' }, { label: t('designer.variablesPanel.modes.record'), value: 'record' }]"
                class="w-full"
                @update:model-value="(mode: string) => setResource({ mode: mode === 'record' ? 'record' : 'list' })"
              />
            </UFormField>
            <!-- One row of three on a desktop, stacked on a phone. -->
            <div class="grid grid-cols-3 gap-3 max-md:grid-cols-1">
              <USwitch
                :model-value="resource.immediate"
                :label="resourcePropLabel('immediate')"
                @update:model-value="(immediate: boolean) => setResource({ immediate })"
              />
              <USwitch
                :model-value="resource.watch"
                :label="resourcePropLabel('watch')"
                @update:model-value="(watch: boolean) => setResource({ watch })"
              />
              <USwitch
                :model-value="resource.count"
                :label="resourcePropLabel('count')"
                @update:model-value="(count: boolean) => setResource({ count })"
              />
            </div>
            <div>
              <UButton
                :label="t('designer.variablesPanel.showRecords')"
                icon="i-lucide-table"
                color="neutral"
                variant="outline"
                :disabled="!resource.resource || !resource.query.fields"
                @click="recordsOpen = true"
              />
            </div>
            <QueryRecordsModal
              v-model:open="recordsOpen"
              :title="t('designer.variablesPanel.recordsTitle', { name: resource.name })"
              :path="recordsPath"
              :query="recordsQuery"
              :notes="recordsNotes"
            />
          </template>

          <!-- CALL -->
          <template v-if="call">
            <UFormField :label="t('designer.variablesPanel.runs')">
              <USelect
                :model-value="call.target.type"
                :items="CALL_TYPES"
                class="w-full"
                @update:model-value="setCallType"
              />
            </UFormField>
            <template v-if="call.target.type === 'TABLE'">
              <UFormField
                :label="t('designer.variablesPanel.action')"
                :description="t('designer.variablesPanel.actionDescription')"
              >
                <USelect
                  :model-value="call.target.action"
                  :items="TABLE_ACTIONS"
                  class="w-full"
                  @update:model-value="(action: TableCallAction) => setCall({ target: { type: 'TABLE', resource: call!.target.type === 'TABLE' ? call!.target.resource : '', action } })"
                />
              </UFormField>
              <UFormField
                :label="t('designer.variablesPanel.table')"
                :description="t('designer.variablesPanel.tableDescription', { method: TABLE_ACTIONS.find(a => call!.target.type === 'TABLE' && a.value === call!.target.action)?.method })"
              >
                <USelectMenu
                  :model-value="call.target.resource || undefined"
                  :items="writableTables"
                  value-key="value"
                  class="w-full"
                  @update:model-value="(id: string) => setCall({ target: { type: 'TABLE', resource: id, action: call!.target.type === 'TABLE' ? call!.target.action : 'CREATE' } })"
                />
              </UFormField>
            </template>
            <UFormField
              v-if="call.target.type === 'WORKFLOW'"
              :label="t('designer.variablesPanel.workflow')"
              :description="t('designer.variablesPanel.workflowDescription')"
            >
              <USelectMenu
                :model-value="call.target.slug || undefined"
                :items="manualWorkflows"
                value-key="value"
                class="w-full"
                @update:model-value="(slug: string) => setCall({ target: { type: 'WORKFLOW', slug } })"
              />
            </UFormField>
            <UFormField
              v-else-if="call.target.type === 'FUNCTION'"
              :label="t('designer.variablesPanel.function')"
            >
              <USelectMenu
                :model-value="call.target.resource || undefined"
                :items="functions"
                value-key="value"
                class="w-full"
                @update:model-value="(id: string) => setCall({ target: { type: 'FUNCTION', resource: id } })"
              />
            </UFormField>
            <UFormField
              :label="cat.variablePropLabel('CALL', 'input', VARIABLE_CATALOG.CALL.props.input.label)"
              :description="t('designer.variablesPanel.inputDescription', INPUT_EXAMPLES)"
              :error="inputError ?? undefined"
            >
              <UTextarea
                v-model="inputText"
                :rows="4"
                autoresize
                class="w-full font-mono"
                @blur="commitInput"
              />
            </UFormField>
          </template>
        </template>

        <!-- Emits -->
        <USeparator :label="t('designer.inspector.tabs.events')" />
        <UFormField
          v-for="[event, meta] in emitEntries"
          :key="event"
          :label="meta.label"
          :hint="event"
          :description="meta.payload ? `event: ${meta.payload}` : undefined"
        >
          <div class="flex gap-1">
            <USelect
              :model-value="handlerOf(event)"
              :items="functionItems"
              class="min-w-0 flex-1"
              @update:model-value="(handler: string) => setHandler(event, handler)"
            />
            <UTooltip
              v-if="handlerOf(event) === NONE"
              :text="t('designer.inspector.createHandler')"
            >
              <UButton
                icon="i-lucide-square-plus"
                color="neutral"
                variant="outline"
                :aria-label="t('designer.inspector.createHandler')"
                @click="createHandler(event)"
              />
            </UTooltip>
            <UTooltip
              v-else
              :text="t('designer.inspector.openInCode')"
            >
              <UButton
                icon="i-lucide-code"
                color="neutral"
                variant="outline"
                :aria-label="t('designer.inspector.openInCode')"
                @click="emit('openHandler', handlerOf(event))"
              />
            </UTooltip>
          </div>
        </UFormField>

        <!-- Used by -->
        <template v-if="selected">
          <USeparator :label="t('designer.variablesPanel.usedBy')" />
          <p class="text-sm text-muted">
            {{ usedBy(selected.name).length ? usedBy(selected.name).join(', ') : t('designer.variablesPanel.unused') }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
