<script setup lang="ts">
/**
 * The TABLE dashboard widget's body - a UTable whose per-row tint,
 * per-column typography and click-to-sort over already-loaded rows are all
 * driven by `config` and each column's presentation
 * (utils/dashboard-widget-render.ts `tableColumns`). Compact padding: a
 * widget is a small card, not a page.
 *
 * Its totals row (D28) is PostgreSQL's - `result.totals`, each column's
 * `columnSettings.<column>.total` over every row the query returns - shown
 * in the column's format. A clickable table (D6) hands its card the clicked
 * row - the hand over each row (DB25); a narrow one shades the edge it can
 * still scroll toward (DB22). A file column (§5.16, D14) shows its file by
 * the run's signed link: an image's thumbnail (a tap opens it large), else a
 * link to it.
 *
 * Colors coming from SQL (`_color`, `_<col>_color`) are data, not
 * trusted styling: only palette names pass `isRoleColor`, anything else
 * is ignored.
 */
import type { TableColumn } from '@nuxt/ui'
import type { DashboardQueryResult } from '~/types/dashboard'
import { isRoleColor, roleColorShade } from '~/types/permission'
import { sortableHeader } from '~/utils/sortable-header'
import DashboardFileImage from '~/components/DashboardFileImage.vue'
import {
  compareTableCells,
  fileLink,
  formatWidgetNumber,
  formatTableCell,
  colorColumn,
  isFileColumn,
  tableColumns,
  type DateDisplay,
  type TableColumnModel
} from '~/utils/dashboard-widget-render'
import { backgroundTint, columnStyleClass, TABLE_ALIGN_CLASS, valueLinkHref } from '~/utils/table-column-style'

const props = defineProps<{
  result: DashboardQueryResult
  config: Record<string, unknown>
  /** Its Columns role - the columns shown, in order (dashboard-builders.ts). */
  shown?: string[]
  /** A click on a row does something (D6) - the row goes to `select`. */
  clickable?: boolean
}>()

const emit = defineEmits<{ select: [row: Record<string, unknown>] }>()

const colorMode = useColorMode()
const { t } = useI18n()
const ui = useUiLocale()
const mode = computed(() => (colorMode.value === 'dark' ? 'dark' : 'light'))

const models = computed(() => tableColumns(props.result, props.config, props.shown))
const rowColorKey = computed(() => colorColumn(props.result, props.config))

// --- Sort: click a header to cycle ascending -> descending -> query order ---
const sortKey = ref<string | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')
function toggleSort(name: string) {
  if (sortKey.value !== name) {
    sortKey.value = name
    sortDir.value = 'asc'
  } else if (sortDir.value === 'asc') {
    sortDir.value = 'desc'
  } else {
    sortKey.value = null
  }
}
watch(() => props.result, () => {
  if (sortKey.value && !models.value.some(c => c.name === sortKey.value)) sortKey.value = null
})
const rows = computed(() => {
  const column = models.value.find(c => c.name === sortKey.value)
  if (!column) return props.result.rows
  const direction = sortDir.value === 'asc' ? 1 : -1
  return [...props.result.rows].sort((a, b) => direction * compareTableCells(a[column.name], b[column.name], column))
})

// --- Styling (utils/table-column-style.ts) ---
const ALIGN_CLASS = TABLE_ALIGN_CLASS

function shade(color: unknown): string | null {
  return isRoleColor(color) ? roleColorShade(color, mode.value) : null
}
function rowStyle(row: Record<string, unknown>): Record<string, string> {
  const color = rowColorKey.value ? shade(row[rowColorKey.value]) : null
  return color ? { backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` } : {}
}
const tableMeta = computed(() => ({
  style: { tr: (row: { original: Record<string, unknown> }) => rowStyle(row.original) },
  // A row that does something on a click shows the hand (DB25).
  class: { tr: props.clickable ? 'cursor-pointer' : '' }
}))
function cellClass(column: TableColumnModel): string {
  return `${ALIGN_CLASS[column.align]} ${columnStyleClass(column.settings, column.numeric)}`
}
function cellStyle(column: TableColumnModel) {
  const color = shade(column.settings.color)
  const background = backgroundTint(shade(column.settings.background) ?? undefined)
  return color || background ? { ...(color ? { color } : {}), ...(background ? { backgroundColor: background } : {}) } : undefined
}
function badgeStyle(row: Record<string, unknown>, column: TableColumnModel) {
  const color = column.badgeColorColumn ? shade(row[column.badgeColorColumn]) : null
  return color ? { color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` } : null
}

// --- Totals row (D28): PostgreSQL's, over every row - in the column's format; a count as a plain number ---
const totals = computed(() => props.result.totals ?? null)
function total(column: TableColumnModel): string {
  const raw = totals.value?.[column.name]
  // `columnSettings.<column>.total` - its config's, carried in its settings.
  const kind = (column.settings as { total?: string }).total
  if (!kind || raw === undefined) return ''
  if (kind === 'count') return formatWidgetNumber(raw, { config: { compact: false }, locale: ui.intlLocale.value })
  return formatTableCell(raw, column, dates, dateTimeFormat.timezone.value)
}
// Dates read in the viewer's zone and format (My account); numbers and words in the UI's language.
const dateTimeFormat = useDateTimeFormat()
const dates: DateDisplay = {
  dateTime: dateTimeFormat.dateTime,
  date: dateTimeFormat.date,
  day: dateTimeFormat.day,
  get locale() { return ui.intlLocale.value },
  get text() { return { empty: t('dashboards.widgetView.empty'), yes: t('common.yes'), no: t('common.no') } }
}

function renderCell(row: Record<string, unknown>, column: TableColumnModel) {
  const raw = row[column.name]
  // A file: its thumbnail or its link, by the run's signed link - its id when the run has none for it.
  const file = isFileColumn(props.result, column.name) ? fileLink(props.result, raw) : undefined
  if (file) return h(DashboardFileImage, { file, variant: 'thumb' })
  const text = formatTableCell(raw, column, dates, dateTimeFormat.timezone.value)
  // Its Link: the value as a link to open it - never the Empty text.
  const link = column.settings.linkType
  if (link && raw !== null && raw !== undefined && text) {
    return h('a', { href: valueLinkHref(link, text), target: link === 'url' ? '_blank' : undefined, rel: 'noopener noreferrer', class: 'text-primary hover:underline' }, text)
  }
  const badge = badgeStyle(row, column)
  // A plain span, not UBadge: its color is an arbitrary palette shade from the query (`_<col>_color`).
  return badge ? h('span', { class: 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', style: badge }, text) : text
}
const columns = computed<TableColumn<Record<string, unknown>>[]>(() => models.value.map(column => ({
  id: column.name,
  header: () => sortableHeader(column.header, sortKey.value === column.name ? sortDir.value : false, () => toggleSort(column.name), column.align),
  cell: ({ row }) => renderCell(row.original, column),
  ...(totals.value ? { footer: () => total(column) } : {}),
  meta: {
    class: { th: ALIGN_CLASS[column.align], td: cellClass(column) },
    style: { td: cellStyle(column) }
  }
})))

function onSelect(_event: Event, row: { original: Record<string, unknown> }) {
  emit('select', row.original)
}
</script>

<template>
  <UTable
    sticky
    :data="rows"
    :columns="columns"
    :meta="tableMeta"
    :ui="{ th: 'px-2 py-1.5', td: 'px-2 py-1.5' }"
    :on-select="clickable ? onSelect : undefined"
    class="dashboard-scroll-shadows h-full"
  />
</template>

<style>
/*
 * DB22: a table wider than its card shades the edge it can still scroll toward. Two covers in the card's color move
 * with the content (`local`) over two shadows fixed to the edges (`scroll`): at the start the left cover hides the
 * left shadow, at the end the right one hides the right - CSS only, no scroll listener.
 *
 * Not scoped: UTable renders a fragment (its template's definition and its root), so a scoped rule's attribute never
 * reaches its scroll container - the class goes on UTable's root (its `class` prop) and this global rule styles it.
 * The PIVOT (DashboardWidgetPivot.vue) uses it too; both are loaded with DashboardWidgetView.vue.
 */
.dashboard-scroll-shadows {
  background:
    linear-gradient(to right, var(--ui-bg) 30%, transparent) left center / 32px 100% no-repeat local,
    linear-gradient(to left, var(--ui-bg) 30%, transparent) right center / 32px 100% no-repeat local,
    radial-gradient(farthest-side at 0 50%, color-mix(in oklab, var(--ui-text) 22%, transparent), transparent) left center / 12px 100% no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, color-mix(in oklab, var(--ui-text) 22%, transparent), transparent) right center / 12px 100% no-repeat scroll;
}
</style>
