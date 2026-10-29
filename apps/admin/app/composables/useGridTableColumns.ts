import { h } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { UCheckbox } from '#components'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { DataViewField } from '~/types/dataview'
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import type { TotalEntry } from '~/utils/column-totals'
import { buildDataViewColumns, type BuildDataViewColumnsOpts } from '~/utils/build-dataview-columns'

type Row = Record<string, unknown>

/**
 * The TABLE's columns as UTable draws them (DataViewGrid.vue): the DataView's
 * columns (build-dataview-columns.ts) with each total in its foot, the
 * leading selection checkbox on the standalone page, the pinned row actions
 * of a narrow Detail, and - on a phone - the first column pinned so the row's
 * name never scrolls away (T55).
 */
export function useGridTableColumns(options: {
  orderedFields: ComputedRef<DataViewField[]>
  sortDirection: (field: string) => 'asc' | 'desc' | false
  onToggleSort: (field: string) => void
  rowMenu: (row: Row) => DropdownMenuItem[][]
  onCopy: (text: string) => void
  displayFormatDefaults: Ref<DisplayFormatDefaults>
  shade: (color: string) => string | undefined
  cellLook: NonNullable<BuildDataViewColumnsOpts['cellLook']>
  headerMenu: NonNullable<BuildDataViewColumnsOpts['headerMenu']>
  cellPrefFor: NonNullable<BuildDataViewColumnsOpts['cellPrefFor']>
  onResizeStart: NonNullable<BuildDataViewColumnsOpts['onResizeStart']>
  onResizeReset: NonNullable<BuildDataViewColumnsOpts['onResizeReset']>
  /** A mouse or a trackpad: a column's header edge drags its width (never with a finger). */
  resizable: () => boolean
  onReorderStart: NonNullable<BuildDataViewColumnsOpts['onReorderStart']>
  /** A mouse or a trackpad, and the viewer may reorder columns (columnsToggle): a header drags its column. */
  reorderable: () => boolean
  /** The DataView's column titles' alignment (`view_config.header_align`) - null: each as its column. */
  headerAlign: () => BuildDataViewColumnsOpts['headerAlign']
  totalsPlanned: ComputedRef<TotalEntry[]>
  totalText: (entry: TotalEntry) => string | null
  /** Keeps the row actions pinned, opaque, at the right edge while the columns scroll sideways. */
  pinRowActions: () => boolean
  /** A leading checkbox column - the standalone page, with something to do with a selection. */
  selectable: () => boolean
  /** At the selection cap: the unticked boxes are disabled (the selection bar says why). */
  atSelectionCap: () => boolean
  /** Below md - the first data column is pinned. */
  isMobile: Ref<boolean>
}) {
  const { t } = useI18n()
  const columnId = (column: TableColumn<Row>) => column.id ?? (column as { accessorKey?: string }).accessorKey

  const dataColumns = computed<TableColumn<Row>[]>(() => pinnedActions(
    buildDataViewColumns(options.orderedFields.value, {
      sortDirection: options.sortDirection,
      onToggleSort: options.onToggleSort,
      rowMenu: options.rowMenu,
      onCopy: options.onCopy,
      displayFormatDefaults: options.displayFormatDefaults.value,
      shade: options.shade,
      cellLook: options.cellLook,
      headerMenu: options.headerMenu,
      cellPrefFor: options.cellPrefFor,
      ...(options.resizable() && { onResizeStart: options.onResizeStart, onResizeReset: options.onResizeReset }),
      ...(options.reorderable() && { onReorderStart: options.onReorderStart }),
      headerAlign: options.headerAlign()
    }).map((column) => {
      const key = (column as { id?: string, accessorKey?: string }).id ?? (column as { accessorKey?: string }).accessorKey
      const entry = options.totalsPlanned.value.find(e => e.column === key)
      return entry ? { ...column, footer: () => options.totalText(entry) ?? '' } : column
    })
  ))

  /** `pinRowActions`: the pinned actions cells are opaque - the theme's translucent pinned background lets the scrolled columns show through; its header cell the header strip's color, solid. */
  function pinnedActions(columns: TableColumn<Row>[]): TableColumn<Row>[] {
    if (!options.pinRowActions()) return columns
    return columns.map(column => column.id === 'actions' ? { ...column, meta: { class: { th: 'w-full bg-[color-mix(in_oklab,var(--ui-bg-elevated)_50%,var(--ui-bg))]', td: 'w-full bg-default' } } } : column)
  }

  // A leading checkbox column, standalone + writable only - built here
  // rather than folded into build-dataview-columns.ts since it's about
  // this grid's own selection state, not a DataView field.
  const columns = computed<TableColumn<Row>[]>(() => {
    if (!options.selectable()) return dataColumns.value
    const selectColumn: TableColumn<Row> = {
      id: 'select',
      header: ({ table }) => h(UCheckbox, {
        'modelValue': table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected(),
        'onUpdate:modelValue': (value: unknown) => table.toggleAllPageRowsSelected(!!value),
        'aria-label': t('dataviews.grid.selectAll')
      }),
      cell: ({ row }) => h(UCheckbox, {
        'modelValue': row.getIsSelected(),
        'onUpdate:modelValue': (value: unknown) => row.toggleSelected(!!value),
        // At the cap: the rest can't be added (the selection bar says why).
        'disabled': !row.getIsSelected() && options.atSelectionCap(),
        'aria-label': t('dataviews.grid.selectRow'),
        // Defensive, not load-bearing today (UCheckbox's own root isn't a
        // plain <button>/<a>, so UTable's `on-select` exclusion wouldn't
        // reliably skip it) - features.rowEdit's own row click must never
        // also toggle this checkbox. Same belt-and-suspenders
        // `@click.stop` ResourcesBrowser.vue's own select column already
        // uses for its identical checkbox-inside-a-clickable-row setup.
        'onClick': (e: MouseEvent) => e.stopPropagation()
      })
    }
    return [selectColumn, ...dataColumns.value]
  })

  /**
   * On a phone the row's first column stays put while the rest scroll under it, a shadow on its edge saying there's
   * more to the right (T55) - the row's name never scrolls away.
   */
  const pinnedFirstColumn = computed(() => {
    if (!options.isMobile.value) return null
    const first = dataColumns.value.find(column => columnId(column) !== 'actions')
    return first ? columnId(first) ?? null : null
  })
  const columnPinning = computed(() => {
    const left = pinnedFirstColumn.value ? [...(columns.value[0]?.id === 'select' ? ['select'] : []), pinnedFirstColumn.value] : []
    const right = options.pinRowActions() ? ['actions'] : []
    return left.length || right.length ? { left, right } : undefined
  })
  /** The columns as the table draws them: a phone's pinned ones opaque, the first data column with its edge's shadow. */
  const tableColumns = computed<TableColumn<Row>[]>(() => {
    const first = pinnedFirstColumn.value
    if (!first) return columns.value
    return columns.value.map((column) => {
      const id = columnId(column)
      if (id !== first && id !== 'select') return column
      // At most 40 % of the screen, its text cut with "…" (M28): the next column always has room beside it.
      const edge = id === first ? ' shadow-[6px_0_6px_-6px_rgb(0_0_0/0.25)] max-w-[40vw] truncate' : ''
      // The checkbox's width as the pinning counts it (TanStack's default is 150px - a gap the rows show through).
      const width = id === 'select' ? ' w-12 min-w-12 max-w-12 shadow-[8px_0_0_0_var(--ui-bg)]' : ''
      return { ...column, ...(id === 'select' && { size: 48 }), meta: { ...column.meta, class: { th: `bg-[color-mix(in_oklab,var(--ui-bg-elevated)_50%,var(--ui-bg))]${edge}${width}`, td: `bg-default${edge}${width}` } } }
    })
  })

  return { tableColumns, columnPinning }
}
