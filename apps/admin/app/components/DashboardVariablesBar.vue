<script setup lang="ts">
/**
 * The row of `$VAR.*` controls above a dashboard's canvas - one control
 * per variable, by type. Purely props-driven (AGENTS.md §21A): the host
 * owns the values (the editor mirrors them in the URL, Apps will too)
 * and supplies `loadOptions`, since a SELECT's options come from the
 * draft definitions in the editor but the published ones in Apps.
 *
 * Values are only ever set explicitly here - an untouched variable keeps
 * using its default, which the server applies. `labels` mirrors what it shows
 * for each value (an option's text, a preset's name) - the dashboard's
 * formulas read it as `{{vars.<name>.label}}` (D3).
 */
import type { DashboardVariable, DashboardVariableOption } from '~/types/dashboard'
import { DATE_RANGE_PRESETS, useDashboardCatalogText } from '~/types/dashboard'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { effectiveVariableValue, isCustomRange } from '~/utils/dashboard-variables'

const props = defineProps<{
  variables: DashboardVariable[]
  /** `values`: the current ones - an options query may read other variables (`dependsOn`). */
  loadOptions: (name: string, values: Record<string, unknown>) => Promise<DashboardVariableOption[]>
}>()
const values = defineModel<Record<string, unknown>>({ required: true })
const labels = defineModel<Record<string, string>>('labels', { default: () => ({}) })
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const catalog = useDashboardCatalogText()

function set(name: string, value: unknown) {
  values.value = { ...values.value, [name]: value }
}
function current(variable: DashboardVariable): unknown {
  return effectiveVariableValue(variable, values.value)
}

// --- SELECT options: loaded per definition set, and again for a dependent
// variable whenever a variable its options query reads changes (§3.6) ---
const options = ref<Record<string, DashboardVariableOption[]>>({})
const optionErrors = ref<Record<string, string>>({})
async function loadOptionsOf(variable: DashboardVariable) {
  try {
    options.value = { ...options.value, [variable.name]: await props.loadOptions(variable.name, values.value) }
    const { [variable.name]: _cleared, ...rest } = optionErrors.value
    optionErrors.value = rest
  } catch (error) {
    optionErrors.value = { ...optionErrors.value, [variable.name]: errorMessage(error, t('dashboards.variablesBar.loadOptionsFailed')) }
    return
  }
  // A value its new options no longer offer is dropped - "the cities of the selected country".
  const value = values.value[variable.name]
  const offered = new Set((options.value[variable.name] ?? []).map(o => o.value))
  if (Array.isArray(value) && value.some(v => !offered.has(String(v)))) set(variable.name, value.filter(v => offered.has(String(v))))
  else if (typeof value === 'string' && !offered.has(value)) set(variable.name, null)
}
watch(() => props.variables, async (variables) => {
  for (const variable of variables.filter(v => v.type === 'SELECT')) await loadOptionsOf(variable)
}, { immediate: true, deep: true })
/** The values a dependent variable's options read, by variable - a change reloads only those. */
function dependencyKey(variable: DashboardVariable): string {
  return JSON.stringify((variable.dependsOn ?? []).map(name => values.value[name] ?? null))
}
watch(() => props.variables.filter(v => v.dependsOn?.length).map(v => [v.name, dependencyKey(v)] as const), (now, before) => {
  const previous = new Map(before ?? [])
  for (const [name, key] of now) {
    if (previous.has(name) && previous.get(name) !== key) {
      const variable = props.variables.find(v => v.name === name)
      if (variable) void loadOptionsOf(variable)
    }
  }
})

const ALL = '__all__'
function selectItems(variable: DashboardVariable) {
  const items = (options.value[variable.name] ?? []).map(o => ({ label: o.label, value: o.value }))
  return variable.multiple ? items : [{ label: t('common.all'), value: ALL }, ...items]
}
function selectValue(variable: DashboardVariable): string | string[] {
  const value = current(variable)
  if (variable.multiple) return Array.isArray(value) ? value.map(String) : []
  return typeof value === 'string' ? value : ALL
}
function onSelect(variable: DashboardVariable, value: string | string[]) {
  set(variable.name, variable.multiple ? value : value === ALL ? null : value)
}

// --- DATE_RANGE: a preset, or a custom from/to pair ---
const CUSTOM = 'custom'
const rangeItems = computed(() => [...DATE_RANGE_PRESETS.map(p => ({ value: p.value, label: catalog.presetLabel(p) })), { value: CUSTOM, label: t('dashboards.variablesBar.customRange') }])
function rangeMode(variable: DashboardVariable): string {
  const value = current(variable)
  if (isCustomRange(value)) return CUSTOM
  return typeof value === 'string' ? value : 'all'
}
function onRangeMode(variable: DashboardVariable, mode: string) {
  if (mode !== CUSTOM) return set(variable.name, mode)
  const today = new Date().toISOString().slice(0, 10)
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  set(variable.name, { from: monthAgo, to: today })
}
function onRangeDate(variable: DashboardVariable, part: 'from' | 'to', date: string) {
  const value = current(variable)
  if (!isCustomRange(value) || !date) return
  set(variable.name, { ...value, [part]: date })
}

// What each variable reads as - an option's label for a SELECT (several joined), a preset's name for a DATE_RANGE.
watchEffect(() => {
  const next: Record<string, string> = {}
  for (const variable of props.variables) {
    const value = current(variable)
    if (variable.type === 'SELECT') {
      const byValue = new Map((options.value[variable.name] ?? []).map(o => [o.value, o.label]))
      const chosen = (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).map(v => byValue.get(String(v)) ?? String(v))
      next[variable.name] = chosen.length ? chosen.join(', ') : t('common.all')
    } else if (variable.type === 'DATE_RANGE') {
      next[variable.name] = isCustomRange(value) ? `${value.from} – ${value.to}` : rangeItems.value.find(i => i.value === value)?.label ?? ''
    } else {
      next[variable.name] = value === null || value === undefined ? '' : String(value)
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(labels.value)) labels.value = next
})

// --- TEXT: committed on Enter / blur, not per keystroke (each commit re-runs widgets) ---
const textDrafts = ref<Record<string, string>>({})
function textValue(variable: DashboardVariable): string {
  return textDrafts.value[variable.name] ?? String(current(variable) ?? '')
}
function commitText(variable: DashboardVariable) {
  const draft = textDrafts.value[variable.name]
  if (draft === undefined) return
  set(variable.name, draft === '' ? null : draft)
  const { [variable.name]: _committed, ...rest } = textDrafts.value
  textDrafts.value = rest
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-3">
    <div
      v-for="variable in variables"
      :key="variable.name"
      class="flex flex-col gap-1"
    >
      <span class="text-xs text-muted">{{ variable.label }}</span>

      <div
        v-if="variable.type === 'DATE_RANGE'"
        class="flex items-center gap-1"
      >
        <USelect
          :model-value="rangeMode(variable)"
          :items="rangeItems"
          :aria-label="variable.label"
          size="sm"
          class="w-40"
          @update:model-value="(v: string) => onRangeMode(variable, v)"
        />
        <template v-if="isCustomRange(current(variable))">
          <UInput
            type="date"
            size="sm"
            :model-value="(current(variable) as { from: string }).from"
            :aria-label="t('dashboards.variablesBar.from', { label: variable.label })"
            @update:model-value="(v: string | number) => onRangeDate(variable, 'from', String(v))"
          />
          <span class="text-xs text-muted">–</span>
          <UInput
            type="date"
            size="sm"
            :model-value="(current(variable) as { to: string }).to"
            :aria-label="t('dashboards.variablesBar.to', { label: variable.label })"
            @update:model-value="(v: string | number) => onRangeDate(variable, 'to', String(v))"
          />
        </template>
      </div>

      <UTooltip
        v-else-if="variable.type === 'SELECT'"
        :text="optionErrors[variable.name]"
        :disabled="!optionErrors[variable.name]"
      >
        <USelectMenu
          :model-value="selectValue(variable)"
          :items="selectItems(variable)"
          value-key="value"
          :multiple="variable.multiple"
          :color="optionErrors[variable.name] ? 'error' : undefined"
          :aria-label="variable.label"
          size="sm"
          class="w-48"
          @update:model-value="(v: string | string[]) => onSelect(variable, v)"
        />
      </UTooltip>

      <UInput
        v-else-if="variable.type === 'TEXT'"
        :model-value="textValue(variable)"
        :aria-label="variable.label"
        size="sm"
        class="w-44"
        @update:model-value="(v: string | number) => (textDrafts[variable.name] = String(v))"
        @keydown.enter="commitText(variable)"
        @blur="commitText(variable)"
      />

      <UInputNumber
        v-else
        :model-value="typeof current(variable) === 'number' ? (current(variable) as number) : undefined"
        :aria-label="variable.label"
        size="sm"
        class="w-32"
        @update:model-value="(v?: number | null) => set(variable.name, v ?? null)"
      />
    </div>
    <!-- Back to every variable's default (D22) - shown once one was changed. -->
    <UButton
      v-if="Object.keys(values).length > 0"
      icon="i-lucide-rotate-ccw"
      :label="t('dashboards.variablesBar.reset')"
      color="neutral"
      variant="ghost"
      size="sm"
      @click="values = {}"
    />
  </div>
</template>
