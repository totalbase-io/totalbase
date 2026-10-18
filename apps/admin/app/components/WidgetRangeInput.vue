<script setup lang="ts">
/**
 * `TRangeInput` - a PostgreSQL range column (T2: tstzrange, tsrange, daterange, int4range, int8range, numrange)
 * edited as two fields, From and To, with the inputs its bounds' type takes: the date picker (WidgetInputDate) for
 * dates and timestamps, a number input for numbers. Both empty is no range (null); one empty, that side is
 * unbounded. A discrete range (dates, whole numbers) reads both ends included - PostgreSQL stores it `[)`, so its
 * To shows the last day or number inside; a continuous one (timestamps, numerics) keeps To excluded, as its
 * default `[)`, and says so. The value is the range's PostgreSQL text, as the Data API reads and writes it.
 */
import WidgetInputDate from '~/components/WidgetInputDate.vue'
import { formatPgRange, inclusiveUpper, parsePgRange, rangeElement, rangeTimestampIso } from '~/utils/pg-range'

const modelValue = defineModel<string | null | undefined>()
const props = defineProps<{
  disabled?: boolean
  /** The bound column's PostgreSQL type (the renderer passes it) - which inputs, and whether it is discrete. */
  columnType?: string
}>()
const { t } = useI18n()

const element = computed(() => rangeElement(props.columnType))
const parsed = computed(() => parsePgRange(modelValue.value))

/** A bound as its input shows it: an ISO timestamp, a day, a number. */
function shown(value: string | null): string | null {
  if (value === null) return null
  return element.value.kind === 'timestamp' ? rangeTimestampIso(value) : value
}

const from = computed<string | null>(() => shown(parsed.value?.lower ?? null))
const to = computed<string | null>(() => {
  const range = parsed.value
  if (!range?.upper) return null
  // A discrete range's exclusive end is one past its last value - shown as that last value.
  if (element.value.discrete && !range.upperInclusive && element.value.kind !== 'timestamp') return inclusiveUpper(range.upper, element.value.kind === 'date' ? 'date' : 'number')
  return shown(range.upper)
})

function write(lower: string | null, upper: string | null) {
  modelValue.value = formatPgRange({
    lower,
    upper,
    lowerInclusive: true,
    // Dates and whole numbers: both ends in; a continuous range: To excluded.
    upperInclusive: element.value.discrete
  })
}
function setFrom(value: unknown) {
  write(value === null || value === undefined || value === '' ? null : String(value), to.value)
}
function setTo(value: unknown) {
  write(from.value, value === null || value === undefined || value === '' ? null : String(value))
}
const numberValue = (value: string | null) => (value === null ? undefined : Number(value))
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="w-12 shrink-0 text-xs text-muted">{{ t('dataviews.rangeInput.from') }}</span>
        <WidgetInputDate
          v-if="element.kind !== 'number'"
          :model-value="from"
          :column-type="element.columnType"
          :disabled="disabled"
          class="min-w-0 flex-1"
          :aria-label="t('dataviews.rangeInput.from')"
          @update:model-value="setFrom"
        />
        <UInputNumber
          v-else
          :model-value="numberValue(from)"
          :disabled="disabled"
          :step-snapping="!element.integer ? false : undefined"
          :format-options="element.integer ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 20 }"
          class="min-w-0 flex-1"
          :aria-label="t('dataviews.rangeInput.from')"
          @update:model-value="setFrom"
        />
      </div>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="w-12 shrink-0 text-xs text-muted">{{ t('dataviews.rangeInput.to') }}</span>
        <WidgetInputDate
          v-if="element.kind !== 'number'"
          :model-value="to"
          :column-type="element.columnType"
          :disabled="disabled"
          class="min-w-0 flex-1"
          :aria-label="t('dataviews.rangeInput.to')"
          @update:model-value="setTo"
        />
        <UInputNumber
          v-else
          :model-value="numberValue(to)"
          :disabled="disabled"
          :step-snapping="!element.integer ? false : undefined"
          :format-options="element.integer ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 20 }"
          class="min-w-0 flex-1"
          :aria-label="t('dataviews.rangeInput.to')"
          @update:model-value="setTo"
        />
      </div>
    </div>
    <p
      v-if="!disabled"
      class="text-xs text-dimmed"
    >
      {{ element.discrete ? t('dataviews.rangeInput.inclusive') : t('dataviews.rangeInput.toExcluded') }}
    </p>
  </div>
</template>
