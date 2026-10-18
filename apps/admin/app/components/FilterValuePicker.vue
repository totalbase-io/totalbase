<script setup lang="ts">
/**
 * A filter condition's value picked instead of typed (FilterConditionBuilder.vue, `=`, `≠` and `in`): from a
 * column's fixed list, or from the rows of the table its foreign key points at - each shown by that table's row
 * presentation, searched on the server (the Data API's `search`), a page at a time. The value is what PostgreSQL
 * stores - the key, the list's value - never its label; `multiple` (`in`) keeps them comma-separated, as the
 * grammar's `_in` does. Read as the viewer: a table they can't read offers nothing, and they type the value instead.
 */
import type { ColumnValueSource } from '~/types/permission'
import { displayColumns, displayText } from '~/utils/display-field'

const props = defineProps<{
  source: ColumnValueSource
  multiple?: boolean
}>()
/** One value, or several comma-separated (`multiple`). */
const model = defineModel<string>({ required: true })

const dataApi = useDataApi()
const { t } = useI18n()

interface Item { value: string, label: string }
const PAGE = 50

const searchTerm = ref('')
const remote = ref<Item[]>([])
const loading = ref(false)
const failed = ref(false)
/** Labels of picked values a page may not hold - so a pick never shows as a bare key. */
const known = reactive<Record<string, string>>({})

function rowItem(row: Record<string, unknown>, source: Extract<ColumnValueSource, { kind: 'relation' }>): Item {
  const value = String(row[source.column] ?? '')
  return { value, label: displayText(source.display, c => row[c]) ?? value }
}
function relationParams(source: Extract<ColumnValueSource, { kind: 'relation' }>) {
  const shown = displayColumns(source.display)
  return { path: dataApi.resourcePath(source.schema, source.table, 'table'), fields: [...new Set([source.column, ...shown])].join(','), orderBy: shown[0] ?? source.column }
}

let timer: ReturnType<typeof setTimeout> | undefined
async function load() {
  const source = props.source
  if (source.kind !== 'relation') return
  loading.value = true
  failed.value = false
  try {
    const { path, fields, orderBy } = relationParams(source)
    const { data } = await dataApi.get<Record<string, unknown>[]>(path, {
      fields,
      order_by: orderBy,
      limit: PAGE,
      ...(searchTerm.value.trim() ? { search: searchTerm.value.trim() } : {})
    })
    remote.value = data.map(row => rowItem(row, source))
    for (const item of remote.value) known[item.value] = item.label
  } catch {
    remote.value = []
    failed.value = true
  } finally {
    loading.value = false
  }
}
watch(searchTerm, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 250)
})
watch(() => props.source, () => void load(), { immediate: true })

const selected = computed<string[]>(() => model.value ? model.value.split(',').filter(v => v !== '') : [])
/** A picked value no loaded page has: read once by its key, for its label. */
watch(selected, async (values) => {
  const source = props.source
  if (source.kind !== 'relation') return
  const missing = values.filter(v => !(v in known))
  if (!missing.length) return
  try {
    const { path, fields } = relationParams(source)
    const { data } = await dataApi.get<Record<string, unknown>[]>(path, { fields, [`where[${source.column}][_in]`]: missing.join(','), limit: missing.length })
    for (const row of data) {
      const item = rowItem(row, source)
      known[item.value] = item.label
    }
  } catch {
    // Its key shows instead.
  }
}, { immediate: true })

const items = computed<Item[]>(() => {
  if (props.source.kind === 'list') return props.source.items
  const list = [...remote.value]
  for (const value of selected.value) {
    if (!list.some(i => i.value === value)) list.unshift({ value, label: known[value] ?? value })
  }
  return list
})

const single = computed<string | undefined>({
  get: () => selected.value[0],
  set: (value) => { model.value = value ?? '' }
})
const many = computed<string[]>({
  get: () => selected.value,
  set: (values) => { model.value = values.join(',') }
})
</script>

<template>
  <USelectMenu
    v-if="multiple"
    v-model="many"
    v-model:search-term="searchTerm"
    :items="items"
    value-key="value"
    multiple
    :loading="loading"
    :ignore-filter="source.kind === 'relation'"
    :placeholder="failed ? t('database.filterConditionBuilder.optionsError') : undefined"
    class="w-full"
  />
  <USelectMenu
    v-else
    v-model="single"
    v-model:search-term="searchTerm"
    :items="items"
    value-key="value"
    :loading="loading"
    :ignore-filter="source.kind === 'relation'"
    :placeholder="failed ? t('database.filterConditionBuilder.optionsError') : undefined"
    class="w-full"
  />
</template>
