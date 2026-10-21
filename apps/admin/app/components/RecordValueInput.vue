<script setup lang="ts">
/**
 * One column's value, picked as the table says, read live (DataViews.md §5.15) - a CHECK list a
 * select, a foreign key a select showing and searched by its row presentation, a boolean a switch, a number, a date
 * or text an input. What the bulk edit panel sets each chosen field with.
 */
import type { DataViewField } from '~/types/dataview'
import type { RecordColumn } from '~/utils/record-engine'
import { flattenQueryObject } from '~/utils/flatten-query-object'
import { foreignKeyDisplay, foreignKeySearch } from '~/utils/foreign-key-display'

const value = defineModel<unknown>({ required: true })
const props = defineProps<{
  meta: RecordColumn
  /** The DataView's field for it - a foreign key's presentation, a CHECK list's labels. */
  field?: DataViewField
  /** Its name for assistive technology - the field it sets. */
  label: string
}>()
const dataApi = useDataApi()

const isNumber = computed(() => /^(smallint|integer|bigint|real|double precision|numeric)/.test(props.meta.dataType))
const inputType = computed(() => (props.meta.dataType === 'date' ? 'date' : props.meta.dataType.startsWith('timestamp') ? 'datetime-local' : isNumber.value ? 'number' : 'text'))
function fromInput(raw: string | number): unknown {
  if (raw === '' || raw === null || raw === undefined) return null
  return /^(smallint|integer|real|double precision)$/.test(props.meta.dataType) ? Number(raw) : raw
}
const checkItems = computed(() => {
  const options = (props.field?.inherited?.options ?? {}) as Record<string, { label?: string }>
  return (props.meta.values ?? []).map(v => ({ value: v, label: options[String(v)]?.label ?? String(v) }))
})

// A foreign key: the rows found for the search, shown by its presentation.
const fkOptions = ref<{ value: unknown, label: string }[]>([])
async function searchFk(term = '') {
  const fk = props.meta.foreignKey
  if (!fk) return
  const display = foreignKeyDisplay(props.field, fk.column)
  const where = foreignKeySearch(display, term)
  try {
    const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(fk.schema, fk.table), {
      fields: [...new Set([fk.column, ...display.columns])].join(','),
      limit: 20,
      order_by: display.columns[0],
      ...(where ? flattenQueryObject(where, 'where') : {})
    })
    fkOptions.value = data.map(row => ({ value: row[fk.column], label: display.text(row) }))
  } catch {
    fkOptions.value = []
  }
}
</script>

<template>
  <USelectMenu
    v-if="meta.foreignKey"
    v-model="value as never"
    :items="fkOptions"
    value-key="value"
    label-key="label"
    :aria-label="label"
    class="w-full"
    ignore-filter
    :search-input="{ placeholder: $t('common.search') }"
    @update:open="(open: boolean) => open && searchFk()"
    @update:search-term="(term: string) => searchFk(term)"
  />
  <USelect
    v-else-if="meta.values"
    v-model="value as never"
    :items="checkItems"
    :aria-label="label"
    class="w-full"
  />
  <USwitch
    v-else-if="meta.dataType === 'boolean'"
    :model-value="value === true"
    :aria-label="label"
    @update:model-value="(on: boolean) => value = on"
  />
  <UInput
    v-else
    :model-value="(value ?? '') as string"
    :type="inputType"
    :aria-label="label"
    class="w-full"
    @update:model-value="(raw: string | number) => value = fromInput(raw)"
  />
</template>
