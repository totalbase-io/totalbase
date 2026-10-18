<script setup lang="ts">
/**
 * A value a threshold or a reference line starts from (D5, `DASHBOARD_VALUE_SOURCE`): a number, a column of the
 * widget's row (`{column}`), a dashboard variable (`{variable}`) - and, for a reference line, a statistic of the series
 * (`average`, `min`, `max`, `median`). A small segmented choice, then the value of that kind.
 */
type ValueSource = number | string | { column: string } | { variable: string }
type Kind = 'number' | 'statistic' | 'column' | 'variable'

const props = defineProps<{
  label: string
  /** The query's number columns, by name. */
  columns: string[]
  /** The dashboard's variables it may read (NUMBER and SELECT). */
  variables: { value: string, label: string }[]
  /** A reference line's statistics - none for a threshold or a band. */
  statistics?: readonly string[]
}>()
const model = defineModel<ValueSource | undefined>()
const { t } = useI18n()

/** The kind chosen while no value of it is set yet. */
const pending = ref<Kind>('number')
const kind = computed<Kind>(() => {
  const value = model.value
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'statistic'
  if (value && typeof value === 'object') return 'column' in value ? 'column' : 'variable'
  return pending.value
})
const kinds = computed(() => (['number', ...(props.statistics ? ['statistic'] : []), 'column', 'variable'] as Kind[])
  .map(value => ({
    value,
    label: t(`dashboards.inspector.source.${value}`),
    // Nothing to pick of that kind - the query has no number column, the dashboard no such variable.
    disabled: (value === 'column' && props.columns.length === 0) || (value === 'variable' && props.variables.length === 0)
  })))
/** Switching kind starts on its first choice - a value of that kind, never a value left of the other. */
function setKind(next: Kind) {
  if (next === kind.value) return
  pending.value = next
  if (next === 'number') model.value = 0
  else if (next === 'statistic') model.value = props.statistics?.[0]
  else if (next === 'column') model.value = props.columns[0] ? { column: props.columns[0] } : undefined
  else model.value = props.variables[0] ? { variable: props.variables[0].value } : undefined
}

const statisticItems = computed(() => (props.statistics ?? []).map(value => ({ value, label: t(`dashboards.inspector.source.statistics.${value}`) })))
const columnItems = computed(() => props.columns.map(name => ({ value: name, label: name })))
const columnValue = computed(() => (model.value && typeof model.value === 'object' && 'column' in model.value ? model.value.column : undefined))
const variableValue = computed(() => (model.value && typeof model.value === 'object' && 'variable' in model.value ? model.value.variable : undefined))
</script>

<template>
  <UFormField :label="label">
    <div class="flex flex-col gap-1">
      <UTabs
        :model-value="kind"
        :items="kinds"
        :content="false"
        size="xs"
        @update:model-value="(v: string | number) => setKind(v as Kind)"
      />
      <UInputNumber
        v-if="kind === 'number'"
        :model-value="typeof model === 'number' ? model : undefined"
        size="sm"
        class="w-full"
        :aria-label="label"
        @update:model-value="(v?: number | null) => model = typeof v === 'number' ? v : undefined"
      />
      <USelect
        v-else-if="kind === 'statistic'"
        :model-value="typeof model === 'string' ? model : undefined"
        :items="statisticItems"
        size="sm"
        class="w-full"
        :aria-label="label"
        @update:model-value="(v: string) => model = v"
      />
      <USelectMenu
        v-else-if="kind === 'column'"
        :model-value="columnValue"
        :items="columnItems"
        value-key="value"
        size="sm"
        class="w-full"
        :aria-label="label"
        @update:model-value="(v: string) => model = v ? { column: v } : undefined"
      />
      <USelectMenu
        v-else
        :model-value="variableValue"
        :items="variables"
        value-key="value"
        size="sm"
        class="w-full"
        :aria-label="label"
        @update:model-value="(v: string) => model = v ? { variable: v } : undefined"
      />
    </div>
  </UFormField>
</template>
