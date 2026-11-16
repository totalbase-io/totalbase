import type { RelationDefinition } from '~/types/schema'
import { displayColumns, displayText, type DisplayConfig } from '~/utils/display-field'

/** One row of the table a Kanban's or Gantt's group column points at - one lane. */
export interface LaneRow {
  /** The related row's key as a string - what `laneOrder` stores and the rows are matched by. */
  pk: string
  /** The key in its real type - what a card's drop writes. */
  rawValue: unknown
  label: string
  /** Its lane color column's value - a palette name or hex. */
  color: string | null
  icon?: string | null
}

/**
 * The lanes of a board or a timeline grouped by a foreign key (types/dataview.ts, `KanbanLayoutConfig`): one page of
 * 100 related rows, titled by the group column's display, ordered by the layout's lane order column (else by what
 * they show) and tinted by its color column - the same fetch ForeignKeySelect.vue makes, refetched when one of
 * those changes. Best-effort: a failed read leaves no lanes, only Unassigned.
 */
export function useLaneRows(options: {
  relation: () => RelationDefinition | null | undefined
  display: () => DisplayConfig | undefined
  orderColumn: () => string | null | undefined
  colorColumn?: () => string | null | undefined
}) {
  const dataApi = useDataApi()
  const rows = ref<LaneRow[]>([])
  watch([options.relation, () => displayColumns(options.display()).join(','), options.orderColumn, () => options.colorColumn?.()], async ([target, , orderColumn, colorColumn]) => {
    rows.value = []
    const display = options.display()
    const shownColumns = displayColumns(display)
    if (!target || shownColumns.length === 0) return
    try {
      const { data } = await dataApi.get<Record<string, unknown>[]>(
        dataApi.resourcePath(target.targetSchema, target.targetTable),
        { fields: [...new Set([target.targetColumn, ...shownColumns, colorColumn].filter((c): c is string => !!c))].join(','), order_by: orderColumn || shownColumns[0], limit: 100 }
      )
      rows.value = data.map(row => ({
        pk: String(row[target.targetColumn]),
        rawValue: row[target.targetColumn],
        label: displayText(display, c => row[c]) ?? String(row[target.targetColumn]),
        color: colorColumn && typeof row[colorColumn] === 'string' ? row[colorColumn] as string : null
      }))
    } catch {
      // Best-effort - the layout renders with only the Unassigned lane.
    }
  }, { immediate: true })
  return rows
}
