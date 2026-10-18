<script setup lang="ts">
/**
 * Settings › Variables (Specification_Dashboards.md §3.3, D26): a dashboard's `$VAR.*` definitions
 * - a list on the left, the selected variable's form on the right,
 * saved as one PATCH. Its default shows and stays as stored - only a change of
 * the variable's type, multiple or source clears it (DB6). The server re-validates everything
 * (packages/dashboards variables.ts); this form only shapes the input.
 * Definitions are versioned with the widgets: a change reaches Apps on
 * the next Publish.
 */
import type { Dashboard, DashboardVariable, DashboardVariableType } from '~/types/dashboard'
import { DASHBOARD_VARIABLE_TYPES, DATE_RANGE_PRESETS, useDashboardCatalogText } from '~/types/dashboard'

const props = defineProps<{ dashboard: Dashboard }>()
const emit = defineEmits<{ saved: [Dashboard] }>()

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const catalog = useDashboardCatalogText()

interface DraftVariable {
  name: string
  label: string
  type: DashboardVariableType
  multiple: boolean
  source: 'STATIC' | 'QUERY' | 'TABLE'
  /** A fixed list's options - each a value and the text the viewer reads ("Yes" for true). */
  staticOptions: { value: string, label: string }[]
  query: string
  /** A list from a table (D22): its resource, and the columns equal to another variable's value (chained). */
  tableResource: string | null
  tableFilters: { column: string, variable: string }[]
  /** Its default: none, a constant (`default`), or a field of the viewer's user row (`defaultField`). */
  defaultSource: 'none' | 'constant' | 'user'
  default: unknown
  defaultField: string
}

function toDraft(variable: DashboardVariable): DraftVariable {
  const options = variable.options
  return {
    name: variable.name,
    label: variable.label,
    type: variable.type,
    multiple: variable.multiple === true,
    source: options?.source ?? 'STATIC',
    staticOptions: options?.source === 'STATIC' ? options.values.map(o => ({ value: o.value, label: o.label ?? '' })) : [],
    query: options?.source === 'QUERY' ? options.query : '',
    tableResource: options?.source === 'TABLE' ? options.resource : null,
    tableFilters: options?.source === 'TABLE' ? (options.filters ?? []).map(f => ({ ...f })) : [],
    defaultSource: variable.default?.source ?? 'none',
    default: variable.default?.source === 'constant' ? variable.default.value : null,
    defaultField: variable.default?.source === 'user' ? variable.default.field : ''
  }
}

function fromDraft(draft: DraftVariable): DashboardVariable {
  const variable: DashboardVariable = { name: draft.name.trim(), label: draft.label.trim() || draft.name.trim(), type: draft.type }
  if (draft.type === 'SELECT') {
    variable.multiple = draft.multiple
    variable.options = draft.source === 'STATIC'
      ? { source: 'STATIC', values: draft.staticOptions.filter(o => o.value.trim()).map(o => (o.label.trim() ? { value: o.value.trim(), label: o.label.trim() } : { value: o.value.trim() })) }
      : draft.source === 'TABLE'
        ? { source: 'TABLE', resource: draft.tableResource ?? '', ...(draft.tableFilters.length ? { filters: draft.tableFilters.filter(f => f.column && f.variable) } : {}) }
        : { source: 'QUERY', query: draft.query }
  }
  if (draft.defaultSource === 'user' && draft.defaultField.trim()) variable.default = { source: 'user', field: draft.defaultField.trim() }
  if (draft.defaultSource === 'constant') {
    const empty = draft.default === null || draft.default === '' || (Array.isArray(draft.default) && draft.default.length === 0)
    if (!empty) variable.default = { source: 'constant', value: draft.default }
  }
  return variable
}

const drafts = ref<DraftVariable[]>([])
// A phone: the variable list stacked above the selected one's fields.
const isMobile = useIsMobile()
const selectedIndex = ref(0)
const selected = computed(() => drafts.value[selectedIndex.value])
const saving = ref(false)

watch(() => props.dashboard.variables, (variables) => {
  drafts.value = variables.map(toDraft)
  selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, variables.length - 1))
}, { immediate: true })
const changed = computed(() => JSON.stringify(drafts.value.map(fromDraft)) !== JSON.stringify(props.dashboard.variables.map(v => fromDraft(toDraft(v)))))

function addVariable() {
  const taken = new Set(drafts.value.map(d => d.name))
  let n = drafts.value.length + 1
  while (taken.has(`variable_${n}`)) n++
  drafts.value.push({ name: `variable_${n}`, label: t('dashboards.variablesModal.defaultLabel', { n }), type: 'SELECT', multiple: false, source: 'STATIC', staticOptions: [], query: '', tableResource: null, tableFilters: [], defaultSource: 'none', default: null, defaultField: '' })
  selectedIndex.value = drafts.value.length - 1
}

function removeSelected() {
  drafts.value.splice(selectedIndex.value, 1)
  selectedIndex.value = Math.max(0, selectedIndex.value - 1)
}

/**
 * A change of its shape - type, multiple, source - invalidates its default: cleared rather than sent for the server to
 * refuse. Only on the author's change: loading a variable never clears what it has (DB6).
 */
function reshape<K extends 'type' | 'multiple' | 'source'>(key: K, value: DraftVariable[K]) {
  const draft = selected.value
  if (!draft || draft[key] === value) return
  draft[key] = value
  draft.default = null
  if (draft.defaultSource === 'constant') draft.defaultSource = 'none'
}

function usage(draft: DraftVariable): string {
  const name = draft.name || '<name>'
  if (draft.type === 'DATE_RANGE') return `$VAR.${name}.from / .to - its previous period: .prev_from / .prev_to`
  if (draft.type === 'SELECT' && draft.multiple) return `status = ANY($VAR.${name})`
  return `($VAR.${name} IS NULL OR column = $VAR.${name})`
}

const typeItems = computed(() => DASHBOARD_VARIABLE_TYPES.map(type => ({ label: catalog.variableTypeLabel(type), value: type.value, description: catalog.variableTypeDescription(type) })))
// Reka UI's SelectItem rejects an empty-string value (reserved for "clear the selection"), so "unset" needs a sentinel.
const NO_DEFAULT = '__none__'
const presetItems = computed(() => [{ label: t('dashboards.variablesModal.noDefault'), value: NO_DEFAULT }, ...DATE_RANGE_PRESETS.map(p => ({ label: catalog.presetLabel(p), value: p.value }))])
const sourceItems = computed(() => [
  { label: t('dashboards.variablesModal.fixedList'), value: 'STATIC', description: t('dashboards.variablesModal.fixedListHelp') },
  { label: t('dashboards.variablesModal.fromTable'), value: 'TABLE', description: t('dashboards.variablesModal.fromTableHelp') },
  { label: t('dashboards.variablesModal.query'), value: 'QUERY', description: t('dashboards.variablesModal.queryHelp') }
])
const defaultSourceItems = computed(() => [
  { label: t('dashboards.variablesModal.defaultNone'), value: 'none' },
  { label: t('dashboards.variablesModal.defaultConstant'), value: 'constant' },
  { label: t('dashboards.variablesModal.defaultUser'), value: 'user' }
])
/** A list from a table: the instance's active tables, and the chosen one's columns (its filters). */
const { resources } = useResourcesList()
const tableItems = computed(() => resources.value.filter(r => r.type === 'TABLE' && r.status === 'ACTIVE').map(r => ({ label: r.name, value: r.id, description: r.schema })))
const tableColumns = ref<string[]>([])
watch(() => selected.value?.tableResource, async (id) => {
  tableColumns.value = []
  if (!id) return
  try {
    tableColumns.value = (await api.get<{ columns: { name: string }[] }>(`/catalog/table/${id}`)).data.columns.map(c => c.name)
  } catch {
    tableColumns.value = []
  }
}, { immediate: true })
const otherVariableItems = computed(() => drafts.value.filter(d => d !== selected.value && d.name).map(d => ({ label: d.label || d.name, value: d.name })))
const staticItems = computed(() => (selected.value?.staticOptions ?? []).filter(o => o.value.trim()).map(o => ({ label: o.label || o.value, value: o.value })))

async function save() {
  saving.value = true
  try {
    const { data } = await api.patch<Dashboard>(`/dashboards/${props.dashboard.id}`, { data: { variables: drafts.value.map(fromDraft) } })
    emit('saved', data)
  } catch (error) {
    notifyError(error, t('dashboards.variablesModal.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection
    :title="t('dashboards.variablesModal.title')"
    :description="t('dashboards.variablesModal.description')"
  >
    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-upload"
      :title="t('dashboards.settings.appliesOnPublish')"
    />
    <div
      class="flex gap-4"
      :class="isMobile ? 'flex-col' : 'min-h-96'"
    >
      <div
        class="flex shrink-0 flex-col gap-1"
        :class="isMobile ? 'border-b border-default pb-3' : 'w-48 border-r border-default pr-3'"
      >
        <button
          v-for="(draft, index) in drafts"
          :key="index"
          type="button"
          class="flex flex-col items-start rounded px-2 py-1.5 text-left text-sm"
          :class="index === selectedIndex ? 'bg-primary/10 text-primary' : 'text-default hover:bg-elevated'"
          @click="selectedIndex = index"
        >
          <span class="font-medium truncate w-full">{{ draft.label || draft.name }}</span>
          <span class="font-mono text-xs text-muted truncate w-full">$VAR.{{ draft.name }}</span>
        </button>
        <p
          v-if="drafts.length === 0"
          class="px-2 py-1.5 text-xs text-muted"
        >
          {{ t('dashboards.variablesModal.empty') }}
        </p>
        <UButton
          icon="i-lucide-plus"
          :label="t('dashboards.variablesModal.add')"
          size="sm"
          color="neutral"
          variant="ghost"
          class="mt-1"
          @click="addVariable"
        />
      </div>

      <div
        v-if="selected"
        class="flex min-w-0 flex-1 flex-col gap-4"
      >
        <div
          class="flex gap-3"
          :class="isMobile ? 'flex-col' : undefined"
        >
          <UFormField
            :label="t('common.name')"
            :description="t('dashboards.variablesModal.nameHelp')"
            class="flex-1"
          >
            <UInput
              v-model="selected.name"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            :label="t('common.label')"
            :description="t('dashboards.variablesModal.labelHelp')"
            class="flex-1"
          >
            <UInput
              v-model="selected.label"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField :label="t('common.type')">
          <USelectMenu

            :model-value="selected.type"
            :items="typeItems"
            value-key="value"
            class="w-full"
            @update:model-value="(v: DashboardVariableType) => reshape('type', v)"
          />
        </UFormField>

        <template v-if="selected.type === 'SELECT'">
          <USwitch

            :model-value="selected.multiple"
            :label="t('dashboards.variablesModal.allowSeveral')"
            @update:model-value="(v: boolean) => reshape('multiple', v)"
          />
          <UFormField :label="t('dashboards.variablesModal.options')">
            <URadioGroup

              :model-value="selected.source"
              :items="sourceItems"
              orientation="horizontal"
              @update:model-value="(v: string) => reshape('source', v as 'STATIC' | 'QUERY' | 'TABLE')"
            />
          </UFormField>
          <!-- A fixed list: each option a value and what the viewer reads - "Yes / No", unset is All. -->
          <UFormField
            v-if="selected.source === 'STATIC'"
            :label="t('dashboards.variablesModal.values')"
            :description="t('dashboards.variablesModal.valuesHelp')"
          >
            <div class="flex flex-col gap-1">
              <div
                v-for="(option, index) in selected.staticOptions"
                :key="index"
                class="flex gap-1"
              >
                <UInput
                  v-model="option.value"
                  :aria-label="t('dashboards.variablesModal.optionValue', { n: index + 1 })"
                  class="min-w-0 flex-1 font-mono"
                />
                <UInput
                  v-model="option.label"
                  :aria-label="t('dashboards.variablesModal.optionLabel', { n: index + 1 })"
                  class="min-w-0 flex-1"
                />
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  :aria-label="t('dashboards.variablesModal.removeOption', { n: index + 1 })"
                  @click="selected.staticOptions.splice(index, 1)"
                />
              </div>
              <div>
                <UButton
                  icon="i-lucide-plus"
                  :label="t('dashboards.variablesModal.addOption')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="selected.staticOptions.push({ value: '', label: '' })"
                />
              </div>
            </div>
          </UFormField>
          <!-- A table: its key the value, its row presentation the label - no SQL; chained by its filters. -->
          <template v-else-if="selected.source === 'TABLE'">
            <UFormField
              :label="t('dashboards.variablesModal.table')"
              :description="t('dashboards.variablesModal.tableHelp')"
            >
              <USelectMenu
                :model-value="selected.tableResource ?? undefined"
                :items="tableItems"
                value-key="value"
                :aria-label="t('dashboards.variablesModal.table')"
                class="w-full"
                @update:model-value="(v: string) => (selected!.tableResource = v)"
              />
            </UFormField>
            <UFormField
              :label="t('dashboards.variablesModal.filters')"
              :description="t('dashboards.variablesModal.filtersHelp')"
            >
              <div class="flex flex-col gap-1">
                <div
                  v-for="(filter, index) in selected.tableFilters"
                  :key="index"
                  class="flex items-center gap-1"
                >
                  <USelectMenu
                    v-model="filter.column"
                    :items="tableColumns"
                    :aria-label="t('dashboards.variablesModal.filterColumn', { n: index + 1 })"
                    class="min-w-0 flex-1"
                  />
                  <span class="text-xs text-muted">=</span>
                  <USelectMenu
                    v-model="filter.variable"
                    :items="otherVariableItems"
                    value-key="value"
                    :aria-label="t('dashboards.variablesModal.filterVariable', { n: index + 1 })"
                    class="min-w-0 flex-1"
                  />
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    :aria-label="t('dashboards.variablesModal.removeFilter', { n: index + 1 })"
                    @click="selected.tableFilters.splice(index, 1)"
                  />
                </div>
                <div>
                  <UButton
                    icon="i-lucide-plus"
                    :label="t('dashboards.variablesModal.addFilter')"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :disabled="!selected.tableResource || otherVariableItems.length === 0"
                    @click="selected.tableFilters.push({ column: '', variable: '' })"
                  />
                </div>
              </div>
            </UFormField>
          </template>
          <UFormField
            v-else
            :label="t('dashboards.variablesModal.optionsQuery')"
            :description="t('dashboards.variablesModal.optionsQueryHelp')"
          >
            <UTextarea
              v-model="selected.query"
              :rows="4"
              class="w-full font-mono text-xs"
            />
          </UFormField>
        </template>

        <!-- Its default: none, a value, or the viewer's own (a field of their user row - their branch). -->
        <UFormField
          :label="t('dashboards.variablesModal.default')"
          :description="t('dashboards.variablesModal.defaultHelp')"
        >
          <div class="flex flex-col gap-2">
            <URadioGroup
              v-model="selected.defaultSource"
              :items="defaultSourceItems"
              orientation="horizontal"
            />
            <template v-if="selected.defaultSource === 'constant'">
              <USelect
                v-if="selected.type === 'DATE_RANGE'"
                :model-value="typeof selected.default === 'string' ? selected.default : undefined"
                :items="presetItems.filter(i => i.value !== NO_DEFAULT)"
                :aria-label="t('dashboards.variablesModal.default')"
                class="w-full"
                @update:model-value="(v: string) => (selected!.default = v)"
              />
              <USelectMenu
                v-else-if="selected.type === 'SELECT' && selected.source === 'STATIC'"
                :model-value="(selected.default as string | string[] | null) ?? (selected.multiple ? [] : undefined)"
                :items="staticItems"
                value-key="value"
                :multiple="selected.multiple"
                :aria-label="t('dashboards.variablesModal.default')"
                class="w-full"
                @update:model-value="(v: string | string[]) => (selected!.default = v)"
              />
              <UInputNumber
                v-else-if="selected.type === 'NUMBER'"
                :model-value="typeof selected.default === 'number' ? selected.default : undefined"
                :aria-label="t('dashboards.variablesModal.default')"
                class="w-full"
                @update:model-value="(v?: number | null) => (selected!.default = v ?? null)"
              />
              <UInput
                v-else
                :model-value="String(selected.default ?? '')"
                :aria-label="t('dashboards.variablesModal.default')"
                class="w-full"
                @update:model-value="(v: string | number) => (selected!.default = String(v) || null)"
              />
            </template>
            <UFormField
              v-else-if="selected.defaultSource === 'user'"
              :label="t('dashboards.variablesModal.userField')"
              :description="t('dashboards.variablesModal.userFieldHelp')"
            >
              <UInput
                v-model="selected.defaultField"
                class="w-full font-mono"
              />
            </UFormField>
          </div>
        </UFormField>

        <div class="mt-auto flex items-end justify-between gap-3">
          <p class="text-xs text-muted">
            {{ t('dashboards.variablesModal.useInSql') }} <code class="font-mono text-highlighted">{{ usage(selected) }}</code>
          </p>
          <UButton
            icon="i-lucide-trash-2"
            :label="t('common.remove')"
            size="sm"
            color="error"
            variant="ghost"
            @click="removeSelected"
          />
        </div>
      </div>
      <p
        v-else
        class="flex flex-1 items-center justify-center text-sm text-muted"
      >
        {{ t('dashboards.variablesModal.addToStart') }}
      </p>
    </div>
    <div class="flex w-full justify-end gap-2">
      <UButton
        :label="t('common.cancel')"
        color="neutral"
        variant="ghost"
        :disabled="saving || !changed"
        @click="drafts = dashboard.variables.map(toDraft)"
      />
      <UButton
        :label="t('common.save')"
        :loading="saving"
        :disabled="!changed"
        @click="save"
      />
    </div>
  </SettingsSection>
</template>
