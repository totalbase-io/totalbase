<script setup lang="ts">
// Field/operator/value form for one condition, embedded in WhereField.vue's
// "Build" popover (Row filter and Validation rules both use WhereField, so
// both get this for free). Emits one
// condition per click of Add; WhereField owns merging it into the actual
// JSON and re-serializing - this component never touches the JSON text
// itself, matching the "additive, not bidirectional" scope agreed there.
import type { CatalogColumn } from '~/types/permission'
import {
  classifyDataType,
  OPERATOR_LABELS,
  OPERATORS_BY_KIND,
  TEXT_MATCH_LABELS,
  TEXT_MATCH_OPERATORS,
  UNARY_OPERATORS,
  VARIABLE_CAPABLE_KINDS,
  wrapLikeValue,
  type ComparisonOperator,
  type TextMatchOperator
} from '~/utils/filterOperators'
import type { Condition } from '~/utils/filterConditions'

/** What this component's own operator picker offers - the real wire operators plus three UI-only "friendly" text ones (see filterOperators.ts's own doc), collapsed back down to a real ComparisonOperator (`_ilike`) in add() below before ever emitting a Condition. */
type BuilderOperator = ComparisonOperator | TextMatchOperator

const props = withDefaults(defineProps<{
  columns: CatalogColumn[]
  /** false for a context with no calling principal to resolve $USER.* against (e.g. a real CHECK constraint - ResourceConstraints.vue sends the conditions, the server writes the expression) - hides the variable toggle entirely rather than offering a token that would mean nothing there. */
  allowVariables?: boolean
  /** The column selected when the builder opens, and again after each add - unset: none. */
  defaultField?: string | undefined
}>(), {
  allowVariables: true,
  defaultField: undefined
})
const emit = defineEmits<{ add: [Condition] }>()
const { t } = useI18n()

const field = ref('')
const operator = ref<BuilderOperator | undefined>(undefined)
/** Back to the start: the default column, with its first operator, or nothing. */
function start() {
  field.value = props.defaultField && props.columns.some(c => c.name === props.defaultField) ? props.defaultField : ''
  operator.value = field.value ? availableOperators.value[0] : undefined
  resetValueInputs()
}
const boolValue = ref<'true' | 'false'>('true')
const useVariable = ref(false)
const variableToken = ref('')
// A number input gives a number back (UInput type="number"): stored as text as it arrives, trimmed only when read (`asText`).
const literalValue = ref('')
/** What an input holds, as text - a number input's number included. */
function asText(value: unknown): string {
  return String(value ?? '').trim()
}
const betweenTo = ref('')

const selectedColumn = computed(() => props.columns.find(c => c.name === field.value))
const kind = computed(() => selectedColumn.value ? classifyDataType(selectedColumn.value.dataType) : 'unknown')
// Text gets the 3 friendly operators too, slotted in right after
// _eq/_neq and before the raw _like/_ilike/_regex (still offered, for
// whoever wants them directly).
const availableOperators = computed<BuilderOperator[]>(() => {
  const base = OPERATORS_BY_KIND[kind.value]
  if (kind.value !== 'text') return base
  return [...base.slice(0, 2), ...TEXT_MATCH_OPERATORS, ...base.slice(2)]
})
const supportsVariable = computed(() => props.allowVariables && VARIABLE_CAPABLE_KINDS.has(kind.value))
const isTextMatch = computed(() => operator.value !== undefined && (TEXT_MATCH_OPERATORS as readonly string[]).includes(operator.value))
const isUnary = computed(() => operator.value !== undefined && !isTextMatch.value && UNARY_OPERATORS.has(operator.value as ComparisonOperator))
const isBetween = computed(() => operator.value === '_between')
/** `=`, `≠` and `in` pick from the column's own values when its caller gives them (`CatalogColumn.values`) - `in` several. */
const PICKED_OPERATORS: readonly string[] = ['_eq', '_neq', '_in']
const pickedValues = computed(() => (operator.value && PICKED_OPERATORS.includes(operator.value) ? selectedColumn.value?.values : undefined))

/** Its title when the caller gives one, else its name. */
const fieldItems = computed(() => props.columns.map(c => ({ label: c.label || c.name, value: c.name })))
const operatorItems = computed(() => availableOperators.value.map(op => ({
  label: (TEXT_MATCH_LABELS as Record<string, string>)[op] ?? OPERATOR_LABELS[op as ComparisonOperator],
  value: op
})))

const inputType = computed(() => {
  switch (kind.value) {
    case 'number': return 'number'
    case 'date': return 'date'
    case 'datetime': return 'datetime-local'
    default: return 'text'
  }
})

function resetValueInputs() {
  boolValue.value = 'true'
  useVariable.value = false
  variableToken.value = ''
  literalValue.value = ''
  betweenTo.value = ''
}

watch(field, () => {
  operator.value = availableOperators.value[0]
  resetValueInputs()
})
watch(operator, resetValueInputs)
// `columns` may arrive after mount (WhereField.vue's own note) - start once they're there.
watch(() => [props.defaultField, props.columns.length] as const, start, { immediate: true })

const canAdd = computed(() => {
  if (!field.value || !operator.value) return false
  if (isUnary.value || kind.value === 'boolean') return true
  if (useVariable.value) return variableToken.value.trim().startsWith('$')
  if (isBetween.value) return asText(literalValue.value) !== '' && asText(betweenTo.value) !== ''
  return asText(literalValue.value) !== ''
})

function currentValue(): Condition['value'] {
  if (isUnary.value) return undefined
  if (kind.value === 'boolean') return boolValue.value
  if (useVariable.value) return variableToken.value.trim()
  if (isBetween.value) return [asText(literalValue.value), asText(betweenTo.value)]
  if (isTextMatch.value) return wrapLikeValue(operator.value as TextMatchOperator, asText(literalValue.value))
  return asText(literalValue.value)
}

function add() {
  if (!canAdd.value || !operator.value) return
  // A friendly text operator is never a real wire operator - it always
  // collapses to _ilike, with currentValue() above doing the wildcard
  // wrap/escape (see filterOperators.ts's own doc on this).
  const realOperator: ComparisonOperator = isTextMatch.value ? '_ilike' : operator.value as ComparisonOperator
  emit('add', { field: field.value, operator: realOperator, value: currentValue() })
  start()
}
</script>

<template>
  <div class="flex w-full flex-col gap-3">
    <UFormField :label="t('database.filterConditionBuilder.field')">
      <USelectMenu
        v-model="field"
        :items="fieldItems"
        value-key="value"
        class="w-full"
      />
    </UFormField>

    <UFormField
      v-if="field"
      :label="t('database.filterConditionBuilder.operator')"
    >
      <OperatorGridMenu
        v-model="operator"
        :items="operatorItems"
      />
    </UFormField>

    <UFormField
      v-if="field && operator"
      :label="t('common.value')"
      :description="useVariable ? t('database.filterConditionBuilder.variableExample', { example: '$USER.id' }) : undefined"
    >
      <p
        v-if="isUnary"
        class="text-xs text-muted"
      >
        {{ t('database.filterConditionBuilder.noValue') }}
      </p>

      <USelect
        v-else-if="kind === 'boolean'"
        v-model="boolValue"
        :items="[{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }]"
        value-key="value"
      />

      <template v-else>
        <UInput
          v-if="useVariable"
          v-model="variableToken"
          :aria-label="t('database.filterConditionBuilder.variable')"
          class="w-full font-mono"
        />
        <div
          v-else-if="isBetween"
          class="flex flex-col gap-2"
        >
          <UFormField :label="t('database.filterConditionBuilder.from')">
            <UInput
              :model-value="literalValue"
              :type="inputType"
              class="w-full"
              @update:model-value="(v) => (literalValue = String(v ?? ''))"
            />
          </UFormField>
          <UFormField :label="t('database.filterConditionBuilder.to')">
            <UInput
              :model-value="betweenTo"
              :type="inputType"
              class="w-full"
              @update:model-value="(v) => (betweenTo = String(v ?? ''))"
            />
          </UFormField>
        </div>
        <FilterValuePicker
          v-else-if="pickedValues"
          v-model="literalValue"
          :source="pickedValues"
          :multiple="operator === '_in'"
        />
        <UInput
          v-else
          :model-value="literalValue"
          :type="inputType"
          class="w-full"
          @update:model-value="(v) => (literalValue = String(v ?? ''))"
          @keydown.enter.prevent="add"
        />

        <label
          v-if="supportsVariable"
          class="flex items-center justify-between gap-2 text-sm cursor-pointer mt-2"
        >
          <span>{{ t('database.filterConditionBuilder.useVariable', { examples: '$USER.id, $CURRENT_DATE, $ROW.total, ...' }) }}</span>
          <USwitch v-model="useVariable" />
        </label>
      </template>
    </UFormField>

    <UButton
      :label="t('database.filterConditionBuilder.addCondition')"
      icon="i-lucide-plus"
      size="sm"
      block
      :disabled="!canAdd"
      @click="add"
    />
  </div>
</template>
