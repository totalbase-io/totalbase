<script setup lang="ts">
/**
 * UTable - a page's Table (Specification_DataViews.md §14.2):
 * Nuxt UI's table as is, plus TotalBase's own Search and Pager around it.
 * Both drive its Rows' Resource on the server (`setSearch`/`setPage`, through
 * the renderer's `onSearch`/`onPage`), so a Resource of thousands of rows is
 * searched and paged by PostgreSQL, never loaded whole. Every other prop,
 * slot and event goes to UTable untouched.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  search?: boolean
  /** The search box as wide as the table - in a modal or a sidebar. */
  searchBlock?: boolean
  pager?: boolean
  /** The page its Resource read, from 1. */
  page?: number
  /** Its Resource's limit - the page size. */
  pageSize?: number | null
  /** Its Resource's total, when it counts. */
  total?: number | null
  /** How many rows this page has - without a total, whether there's a next one. */
  rowCount?: number
  /** Its Resource's search, as set - by this box or by code (`setSearch`); the box shows it. */
  searchText?: string | null
}>()
const emit = defineEmits<{
  search: [text: string]
  page: [page: number]
  /** Enter in the search box - its text, searched now (the renderer awaits the Resource before the page's function). */
  searchEnter: [text: string]
}>()
defineSlots<Record<string, (scope: Record<string, unknown>) => unknown>>()

const { t } = useI18n()
const text = ref(props.searchText ?? '')
let timer: ReturnType<typeof setTimeout> | undefined
function typed(value: string) {
  text.value = value
  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    emit('search', value)
  }, 300)
}
// Its Resource's search set elsewhere (code, another widget): the box shows it - while nothing typed here is pending.
watch(() => props.searchText, (value) => {
  if (timer === undefined && (value ?? '') !== text.value.trim()) text.value = value ?? ''
})
/** Enter: no waiting - what's typed is searched at once, by whoever handles it. */
function enter() {
  clearTimeout(timer)
  timer = undefined
  emit('searchEnter', text.value)
}
onBeforeUnmount(() => clearTimeout(timer))

const size = computed(() => props.pageSize ?? 0)
/** Without a total, one page more while this one is full - enough to step forward. */
const knownTotal = computed(() => props.total ?? ((props.page ?? 1) - 1) * size.value + (props.rowCount ?? 0) + ((props.rowCount ?? 0) >= size.value ? 1 : 0))
const showPager = computed(() => props.pager && size.value > 0 && knownTotal.value > size.value)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <UInput
      v-if="search"
      :model-value="text"
      icon="i-lucide-search"
      :placeholder="t('dataviews.widgetTable.searchPlaceholder')"
      :aria-label="t('common.search')"
      :class="searchBlock ? 'w-full' : 'w-full max-w-xs'"
      @update:model-value="(v: string | number) => typed(String(v))"
      @keydown.enter.prevent="enter"
    />
    <UTable
      v-bind="$attrs"
      class="min-h-0 flex-1"
    >
      <template
        v-for="(_, slot) in $slots"
        :key="slot"
        #[slot]="scope"
      >
        <slot
          :name="slot"
          v-bind="scope ?? {}"
        />
      </template>
    </UTable>
    <div
      v-if="showPager"
      class="flex justify-end"
    >
      <UPagination
        :page="page ?? 1"
        :items-per-page="size"
        :total="knownTotal"
        :aria-label="t('shell.paginationLabel')"
        size="sm"
        @update:page="(n: number) => emit('page', n)"
      />
    </div>
  </div>
</template>
