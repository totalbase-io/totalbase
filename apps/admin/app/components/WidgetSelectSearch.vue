<script setup lang="ts">
/**
 * A Select menu's search window (Specification_DataViews.md §9.8, `searchWindow`): its Resource as a table - the
 * Resource's fields as columns, searched and paged on the server (WidgetTable) - in a sidebar or a modal, full screen
 * on a phone. One row is picked: a click, or ↑ ↓ and Enter from the search box; Esc closes.
 */
import type { TableColumn } from '@nuxt/ui'
import { UModal, USlideover } from '#components'
import type { EditSize } from '~/types/dataview'
import { FULLSCREEN_WHEN_COMPACT, OVERLAY_CONTENT_WIDTH } from '~/utils/overlay-size'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  title: string
  as: 'sidebar' | 'modal'
  /** Its width (`searchWindowSize`) - unset: Nuxt UI's own (max-w-md as a sidebar, max-w-lg as a modal). */
  size?: EditSize
  columns: TableColumn<Record<string, unknown>>[] | undefined
  rows: Record<string, unknown>[]
  page: number
  pageSize: number | null
  total: number | null
  searchText: string | null
  loading: boolean
  /** Searches its Resource - resolves once it has read. */
  search: (text: string) => Promise<unknown>
  setPage: (page: number) => Promise<unknown>
}>()
const emit = defineEmits<{ pick: [row: Record<string, unknown>] }>()

const { t } = useI18n()
const isCompact = useCompactUi()
/** The row ↑ ↓ moves to and Enter picks - the first one after each read. */
const highlighted = ref(0)
watch(() => props.rows, () => {
  highlighted.value = 0
})

function pick(row: Record<string, unknown> | undefined) {
  if (row) emit('pick', row)
}
/** Enter: what's typed searched at once, then the highlighted row picked. */
async function enter(text: string) {
  if ((props.searchText ?? '') !== text.trim()) await props.search(text)
  pick(props.rows[highlighted.value])
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const last = props.rows.length - 1
  highlighted.value = Math.max(0, Math.min(last, highlighted.value + (event.key === 'ArrowDown' ? 1 : -1)))
}
const meta = computed(() => ({ class: { tr: (row: { index: number }) => (row.index === highlighted.value ? 'bg-elevated' : '') } }))
// The search box takes the focus as it opens.
const body = ref<HTMLElement | null>(null)
watch(open, (isOpen) => {
  if (isOpen) setTimeout(() => body.value?.querySelector<HTMLInputElement>('input')?.focus(), 50)
})
</script>

<template>
  <component
    :is="as === 'modal' ? UModal : USlideover"
    v-model:open="open"
    :title="title"
    :description="t('dataviews.widgetSelectSearch.description')"
    :fullscreen="as === 'modal' && (!size || FULLSCREEN_WHEN_COMPACT.includes(size)) ? isCompact : undefined"
    :ui="size ? { content: OVERLAY_CONTENT_WIDTH[size] } : undefined"
  >
    <template #body>
      <div
        ref="body"
        class="flex h-full min-h-0 min-w-0 flex-col"
        @keydown="onKeydown"
      >
        <WidgetTable
          search
          search-block
          pager
          sticky
          :data="rows"
          :columns="columns"
          :loading="loading"
          :meta="meta"
          :page="page"
          :page-size="pageSize"
          :total="total"
          :row-count="rows.length"
          :search-text="searchText"
          :on-select="(_e: Event, row: { original: Record<string, unknown> }) => pick(row.original)"
          :ui="{ tr: 'cursor-pointer' }"
          class="min-h-0 min-w-0 flex-1"
          @search="search"
          @page="setPage"
          @search-enter="enter"
        >
          <template #empty>
            <UEmpty
              variant="naked"
              size="sm"
              icon="i-lucide-search-x"
              :title="t('dataviews.widgetSelectSearch.noRows')"
            />
          </template>
        </WidgetTable>
      </div>
    </template>
  </component>
</template>
