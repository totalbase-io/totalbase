<script setup lang="ts">
/**
 * The PIVOT dashboard widget's body (Specification_Dashboards.md §5.17, D17): a UTable over rows PostgreSQL already
 * aggregated - its row levels down the side, its value columns under nested headers (each Columns value × each
 * value, then the totals), its subtotal and total rows and its total columns in bold. It only places the cells
 * (utils/dashboard-pivot.ts): every total is PostgreSQL's row, never a sum made here. Values read in their
 * `columnSettings` over their presentation; an empty cell its Empty text.
 *
 * Clickable (D6), a detail cell hands its card its result row - its rows' and columns' values and its value; a total
 * isn't clickable. Wider than its card, it scrolls sideways with its edges shaded (DB22, DashboardWidgetTable.vue's
 * `dashboard-scroll-shadows`).
 */
import type { TableColumn } from '@nuxt/ui'
import type { DashboardQueryResult } from '~/types/dashboard'
import { buildPivot, pivotRowLabels, type PivotHeader, type PivotRow } from '~/utils/dashboard-pivot'
import { pivotSpec, pivotTexts, type DateDisplay, type PivotRoles } from '~/utils/dashboard-widget-render'

const props = withDefaults(defineProps<{
  result: DashboardQueryResult
  config: Record<string, unknown>
  roles: PivotRoles
  dates: DateDisplay
  timezone?: string
  /** A click on a detail cell does something (D6) - its row goes to `select`. */
  clickable?: boolean
}>(), {
  timezone: undefined,
  clickable: false
})

const emit = defineEmits<{ select: [row: Record<string, unknown>] }>()

const model = computed(() => buildPivot(props.result.rows, pivotSpec(props.result, props.config, props.roles)))
const texts = computed(() => pivotTexts(props.result, props.config, props.roles, props.dates, props.timezone))

/** A row's level labels - a detail row leaves out the levels its previous row already says. */
function rowLabel(row: PivotRow, index: number, level: number): string {
  const labels = pivotRowLabels(row, props.roles.rows.length, (i, raw) => texts.value.dimension(props.roles.rows[i]!, raw), texts.value.total)
  const previous = model.value.rows[index - 1]
  const repeated = row.kind === 'detail' && previous?.kind === 'detail' && level < row.level - 1
    && row.path.slice(0, level + 1).every((raw, i) => JSON.stringify(raw ?? null) === JSON.stringify(previous.path[i] ?? null))
  return repeated ? '' : labels[level]!
}

function headerText(node: PivotHeader): string {
  if (node.kind === 'total') return texts.value.total
  if (node.kind === 'value') return texts.value.title(node.column!)
  return texts.value.dimension(node.column!, node.raw)
}

function select(row: PivotRow, index: number) {
  const cell = row.cells[index]
  if (props.clickable && row.kind === 'detail' && cell && !model.value.leaves[index]?.total) emit('select', cell)
}

function valueCell(row: PivotRow, index: number) {
  const leaf = model.value.leaves[index]!
  const text = texts.value.value(leaf.value, row.cells[index]?.[leaf.value])
  if (!props.clickable || row.kind !== 'detail' || leaf.total || !row.cells[index]) return text
  return h('span', {
    role: 'button',
    tabindex: 0,
    class: 'cursor-pointer hover:underline',
    onClick: () => select(row, index),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select(row, index)
      }
    }
  }, text)
}

const columns = computed<TableColumn<PivotRow>[]>(() => {
  const leafIndex = new Map(model.value.leaves.map((leaf, i) => [leaf.key, i]))
  const toColumn = (node: PivotHeader): TableColumn<PivotRow> => {
    if (node.leaf) {
      const index = leafIndex.get(node.leaf.key)!
      const total = node.leaf.total
      return {
        id: node.leaf.key,
        header: headerText(node),
        cell: ({ row }) => valueCell(row.original, index),
        meta: { class: { th: 'text-right', td: `text-right tabular-nums${total ? ' font-semibold text-highlighted' : ''}` } }
      }
    }
    return { id: node.id, header: headerText(node), columns: node.children.map(toColumn), meta: { class: { th: 'text-center' } } }
  }
  return [
    ...props.roles.rows.map((dimension, level): TableColumn<PivotRow> => ({
      id: `row:${dimension}`,
      header: texts.value.title(dimension),
      cell: ({ row }) => rowLabel(row.original, row.index, level),
      meta: { class: { td: 'text-highlighted' } }
    })),
    ...model.value.headers.map(toColumn)
  ]
})

/** Subtotal and total rows in bold. */
const tableMeta = { class: { tr: (row: { original: PivotRow }) => (row.original.kind === 'detail' ? '' : 'font-semibold text-highlighted') } }
</script>

<template>
  <UTable
    sticky
    :data="model.rows"
    :columns="columns"
    :meta="tableMeta"
    :ui="{ th: 'px-2 py-1.5', td: 'px-2 py-1.5' }"
    class="dashboard-scroll-shadows h-full"
  />
</template>
