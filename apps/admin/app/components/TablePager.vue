<script setup lang="ts">
/**
 * The pager every admin list uses - "1–10 of 42 users", page size, and the
 * page buttons - so each table stops re-writing the same block. Goes in a
 * PageShell's #footer (AGENTS.md section 25, "Page structure"); inline only
 * where the table sits inside another page (an embedded PageShell, a
 * slideover, a DataView grid).
 *
 * On a phone it's one row - summary, page size, ‹ page / pages › - rather
 * than the desktop's numbered buttons, which don't fit its width; `compact`
 * asks for that row anywhere narrow (a modal). The numbered buttons show the
 * first and last page always, so they go without « and ».
 */
const props = withDefaults(defineProps<{
  total: number
  /** The server stopped counting at `total` - shown as "10,000+" (audit logs' capped count). */
  totalCapped?: boolean
  /**
   * Singular noun for the summary, e.g. "user" - pluralized with an "s"
   * unless `plural` is given (pass both, translated, for any language but
   * English). Neither given: "row"/"rows" in the UI's language.
   */
  noun?: string
  plural?: string
  pageSizeOptions?: number[]
  /** A fixed page size (bind `page-size` one-way) - no page-size select. */
  hidePageSize?: boolean
  /** The phone's one row - ‹ page / pages › - at any width: for a narrow place, a modal. */
  compact?: boolean
}>(), {
  noun: undefined,
  plural: undefined,
  totalCapped: false,
  pageSizeOptions: () => [10, 20, 50, 100],
  hidePageSize: false,
  compact: false
})
const page = defineModel<number>('page', { required: true })
const pageSize = defineModel<number>('pageSize', { required: true })

const isMobile = useIsMobile()
const { t } = useI18n()
const ui = useUiLocale()
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / pageSize.value)))
const pageSizeItems = computed(() => props.pageSizeOptions.map(n => ({ label: String(n), value: n })))

const summary = computed(() => {
  const noun = props.noun ?? t('database.tablePager.row')
  const plural = props.plural ?? (props.noun === undefined ? t('database.tablePager.rows') : `${props.noun}s`)
  if (props.total === 0) return t('database.tablePager.summaryEmpty', { plural })
  const first = (page.value - 1) * pageSize.value + 1
  const last = Math.min(page.value * pageSize.value, props.total)
  const total = props.totalCapped ? `${props.total.toLocaleString(ui.intlLocale.value)}+` : props.total
  return t('database.tablePager.summary', { first, last, total, noun: props.total === 1 && !props.totalCapped ? noun : plural })
})
</script>

<template>
  <div
    v-if="isMobile || compact"
    class="flex items-center justify-between gap-2"
  >
    <span class="min-w-0 truncate text-sm text-muted">{{ summary }}</span>
    <div class="flex shrink-0 items-center gap-1.5">
      <USelect
        v-if="!hidePageSize"
        v-model="pageSize"
        :items="pageSizeItems"
        size="sm"
        class="w-20"
        :aria-label="t('database.tablePager.rowsPerPage')"
      />
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        size="sm"
        :aria-label="t('database.tablePager.previousPage')"
        :disabled="page <= 1"
        @click="page--"
      />
      <span class="min-w-12 text-center text-sm tabular-nums">{{ page }} / {{ pageCount }}</span>
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        size="sm"
        :aria-label="t('database.tablePager.nextPage')"
        :disabled="page >= pageCount"
        @click="page++"
      />
    </div>
  </div>
  <div
    v-else
    class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"
  >
    <span class="text-sm text-muted">{{ summary }}</span>
    <div class="flex items-center gap-3">
      <USelect
        v-if="!hidePageSize"
        v-model="pageSize"
        :items="pageSizeItems"
        size="sm"
        class="w-24"
        :aria-label="t('database.tablePager.rowsPerPage')"
      />
      <UPagination
        v-model:page="page"
        :total="total"
        :items-per-page="pageSize"
        show-edges
        :sibling-count="1"
        :show-controls="false"
        :aria-label="t('shell.paginationLabel')"
        size="sm"
      >
        <!-- Only ‹ and ›: the first and last page are always there as numbers. -->
        <template #prev>
          <UButton
            icon="i-lucide-chevron-left"
            color="neutral"
            variant="outline"
            size="sm"
            :aria-label="t('database.tablePager.previousPage')"
          />
        </template>
        <template #next>
          <UButton
            icon="i-lucide-chevron-right"
            color="neutral"
            variant="outline"
            size="sm"
            :aria-label="t('database.tablePager.nextPage')"
          />
        </template>
      </UPagination>
    </div>
  </div>
</template>
