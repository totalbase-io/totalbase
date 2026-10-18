<script setup lang="ts">
/**
 * A pivot's row order by a value's total (D17, `config.sortBy`: {value, direction}): a Values column and ascending or
 * descending. Unset (`undefined`): the rows by their own values. A value set before that the Values no longer hold
 * stays listed, so it can be changed.
 */
interface PivotSort { value: string, direction?: 'ASC' | 'DESC' }

const props = defineProps<{
  /** The Values columns, resolved. */
  values: string[]
}>()
const model = defineModel<PivotSort | undefined>()
const { t } = useI18n()

/** A select can't hold an empty value - "by the rows' own values" is this. */
const NONE = '__none__'
const valueItems = computed(() => [
  { value: NONE, label: t('dashboards.inspector.pivotSort.none') },
  ...[...props.values, ...(model.value && !props.values.includes(model.value.value) ? [model.value.value] : [])].map(value => ({ value, label: value }))
])
function setValue(value: string) {
  model.value = value === NONE ? undefined : { value, direction: model.value?.direction ?? 'DESC' }
}
function setDirection(direction: 'ASC' | 'DESC') {
  if (model.value) model.value = { value: model.value.value, direction }
}
const directionItems = computed(() => (['DESC', 'ASC'] as const).map(value => ({ value, label: t(`dashboards.inspector.pivotSort.directions.${value}`) })))
</script>

<template>
  <div class="flex gap-2 max-md:flex-col">
    <UFormField
      :label="t('dashboards.inspector.pivotSort.value')"
      class="min-w-0 flex-1"
    >
      <USelect
        :model-value="model?.value ?? NONE"
        :items="valueItems"
        class="w-full"
        @update:model-value="setValue"
      />
    </UFormField>
    <UFormField
      :label="t('dashboards.inspector.pivotSort.direction')"
      class="min-w-0 flex-1"
    >
      <USelect
        :model-value="model?.direction ?? 'ASC'"
        :items="directionItems"
        :disabled="!model"
        class="w-full"
        @update:model-value="(v: string) => setDirection(v as 'ASC' | 'DESC')"
      />
    </UFormField>
  </div>
</template>
