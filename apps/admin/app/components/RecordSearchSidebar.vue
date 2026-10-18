<script setup lang="ts">
/**
 * "Search" (DataViewRecordPage.vue's header) - a FORM DataView's own record picker, since that layout has
 * no grid to browse rows in. Opens as a USlideover on the RIGHT (the
 * chat's own call - reads as "coming alongside the form", the same side
 * a SIDEBAR edit-presentation slides from by default elsewhere) staying
 * open across multiple picks, unlike a modal that would need reopening
 * for every next lookup.
 *
 * Lists rows via the public Data API's own `search`+`fields` query
 * params (packages/query-engine's `compileSearch`): the search looks in
 * the fields read - `labelFields`, what each result shows
 * (Specification_Data_API.md §3.5).
 *
 * Paginated `PAGE_SIZE` at a time (`count: true` + `meta.count`, the
 * SAME params/response shape DataViewGrid.vue's own list fetch already
 * uses) rather than one big unpaginated fetch - keeps each page small
 * regardless of how large the underlying table is.
 */
import type { DataViewField } from '~/types/dataview'
import { searchForApi } from '~/utils/search-terms'

const props = defineProps<{
  schema: string
  resourceName: string
  /** The source's kind - a view's rows are read at /view/. */
  resourceKind?: 'table' | 'view'
  primaryKey: string
  /** The columns read, shown per result row and searched (DataViewRecordPage.vue). */
  labelFields: DataViewField[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ select: [pk: string] }>()

const dataApi = useDataApi()
const { t } = useI18n()
const { patterns: datePatterns } = useDateTimeFormat()
const search = ref('')
const page = ref(1)
const PAGE_SIZE = 15

const fieldNames = computed(() => {
  const names = new Set(props.labelFields.map(f => f.columnName!))
  names.add(props.primaryKey)
  return [...names]
})

const { data, pending, error, refresh } = useAsyncData(
  () => `record-search-${props.schema}-${props.resourceName}-${search.value}-${page.value}`,
  () => dataApi.get<Record<string, unknown>[]>(
    dataApi.resourcePath(props.schema, props.resourceName, props.resourceKind ?? 'table'),
    {
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
      count: true,
      order_by: props.primaryKey,
      fields: fieldNames.value.join(','),
      ...(search.value ? { search: searchForApi(search.value, datePatterns.value.date) } : {})
    }
  ),
  { watch: [open, page], immediate: false }
)
const rows = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.meta?.count ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

// Re-fetch on every keystroke (debounced) once the sidebar is open, and
// once right when it opens - `watch: [open]` above only covers the
// open/close transition itself, not a search typed while already open.
let debounceTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  if (!open.value) return
  page.value = 1
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => refresh(), 250)
})
watch(open, (value) => {
  if (value) {
    refresh()
  } else {
    search.value = ''
    page.value = 1
  }
})

/** One result row's own label - every non-PK label field's value, joined; falls back to the raw PK when there's nothing else to show. */
function labelFor(row: Record<string, unknown>): string {
  const parts = props.labelFields
    .filter(f => f.columnName !== props.primaryKey)
    .map(f => row[f.columnName!])
    .filter(v => v !== null && v !== undefined && v !== '')
  return parts.length ? parts.join(' · ') : String(row[props.primaryKey] ?? '')
}

function select(row: Record<string, unknown>) {
  const pk = row[props.primaryKey]
  if (pk === null || pk === undefined) return
  emit('select', String(pk))
  open.value = false
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="t('dataviews.search.title')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <UInput
          v-model="search"
          :aria-label="t('dataviews.search.placeholder')"
          icon="i-lucide-search"
          :placeholder="t('dataviews.search.placeholder')"
          autofocus
        />

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error.message"
        />

        <UEmpty
          v-if="pending"
          loading
          variant="naked"
          size="sm"
        />

        <UEmpty
          v-else-if="!rows.length"
          variant="naked"
          size="sm"
          icon="i-lucide-search"
          :title="t('dataviews.search.empty')"
        />

        <template v-else>
          <div class="flex flex-col divide-y divide-default rounded-lg ring-1 ring-default">
            <button
              v-for="row in rows"
              :key="String(row[primaryKey])"
              type="button"
              class="flex flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-elevated"
              @click="select(row)"
            >
              <span class="font-medium text-highlighted">{{ labelFor(row) }}</span>
              <span class="text-xs text-muted">{{ row[primaryKey] }}</span>
            </button>
          </div>

          <div
            v-if="totalPages > 1"
            class="flex items-center justify-between text-sm"
          >
            <UButton
              icon="i-lucide-chevron-left"
              :label="t('dataviews.record.previous')"
              color="neutral"
              variant="subtle"
              size="xs"
              :disabled="page <= 1"
              @click="page--"
            />
            <span class="text-xs text-muted">{{ t('dataviews.print.pageOf', { page, pages: totalPages }) }}</span>
            <UButton
              icon="i-lucide-chevron-right"
              trailing
              :label="t('common.next')"
              color="neutral"
              variant="subtle"
              size="xs"
              :disabled="page >= totalPages"
              @click="page++"
            />
          </div>
        </template>
      </div>
    </template>
  </USlideover>
</template>
