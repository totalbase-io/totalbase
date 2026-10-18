<script setup lang="ts">
/**
 * "Show records": what a Data API query brings, as written, with the
 * author's permissions - a variable's Resource query, a DataView's Scope
 * filter. Opens at once and pages the records on the server PAGE_SIZE at a
 * time, compact rows, never past the query's own limit/offset. A table is
 * an editor-sized modal: fullscreen on a phone or a tablet.
 *
 * The caller owns what the query is and what to say about it (`notes`);
 * this only runs it.
 */
import { DENSITY_META } from '~/types/dataview'
import { toDataApiParams } from '~/utils/data-api-query'

const props = defineProps<{
  title: string
  /** The Data API path (useDataApi().resourcePath) - null: nothing to run. */
  path: string | null
  /** Data API query object (fields, where, order_by, limit, offset...). */
  query: Record<string, unknown>
  /** Lines shown above the table - what differs from the real page. */
  notes?: string[]
}>()
const open = defineModel<boolean>('open', { default: false })

const PAGE_SIZE = 20
const dataApi = useDataApi()
const isCompact = useCompactUi()
const { t } = useI18n()

const page = ref(1)
const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
const ms = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
let request = 0

const source = computed(() => {
  const { limit, offset, count: _count, ...rest } = props.query
  return {
    query: rest,
    offset: typeof offset === 'number' ? offset : 0,
    limit: typeof limit === 'number' ? limit : null
  }
})

async function load() {
  if (!props.path) return
  const { query, offset, limit } = source.value
  const current = ++request
  const start = (page.value - 1) * PAGE_SIZE
  const size = limit === null ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - start)
  loading.value = true
  const started = performance.now()
  try {
    const { data, meta } = await dataApi.get<Record<string, unknown>[]>(props.path, toDataApiParams({ ...query, offset: offset + start, limit: Math.max(size, 1), count: true }))
    if (current !== request) return
    const matching = Math.max(((meta as { count?: number } | undefined)?.count ?? data.length) - offset, 0)
    rows.value = data
    total.value = limit === null ? matching : Math.min(matching, limit)
    ms.value = Math.round(performance.now() - started)
    error.value = null
  } catch (err) {
    if (current === request) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (current === request) loading.value = false
  }
}

// Every opening starts over, on the first page.
watch(open, (isOpen) => {
  if (!isOpen) return
  page.value = 1
  rows.value = []
  total.value = 0
  error.value = null
  void load()
})
watch(page, () => {
  if (open.value) void load()
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="loading && !rows.length ? t('common.loading') : t('database.queryRecordsModal.summary', { total, ms }, total)"
    :fullscreen="isCompact"
    :ui="{ content: isCompact ? undefined : 'max-w-5xl' }"
  >
    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error"
      />
      <UEmpty
        v-else-if="loading && !rows.length"
        loading
        variant="naked"
        size="sm"
      />
      <div
        v-else
        class="flex flex-col gap-3"
      >
        <p
          v-for="note in notes ?? []"
          :key="note"
          class="text-xs text-muted"
        >
          {{ note }}
        </p>
        <UTable
          :data="rows"
          :loading="loading"
          sticky
          :ui="{ td: DENSITY_META.compact.td, th: DENSITY_META.compact.th }"
          class="max-h-[60vh]"
        >
          <template #empty>
            <UEmpty
              icon="i-lucide-table"
              :title="t('database.queryRecordsModal.noRecords')"
              :description="t('database.queryRecordsModal.nothingMatches')"
              variant="naked"
            />
          </template>
        </UTable>
      </div>
    </template>
    <template
      v-if="total > PAGE_SIZE"
      #footer
    >
      <TablePager
        v-model:page="page"
        :page-size="PAGE_SIZE"
        :total="total"
        :noun="t('database.queryRecordsModal.record')"
        :plural="t('database.queryRecordsModal.records')"
        hide-page-size
        compact
        class="w-full"
      />
    </template>
  </UModal>
</template>
