/**
 * A grid's totals (DataViews.md §4.9): a column's `config.total` - sum, average, minimum, maximum or
 * count - over every row the list's filters keep, not only the page: PostgreSQL computes it, as the Data API's
 * aggregates (§3.8 there), in a read of its own beside the rows'.
 */
import type { DataViewField } from '~/types/dataview'

export const TOTAL_KINDS = ['sum', 'avg', 'min', 'max', 'count'] as const
export type TotalKind = (typeof TOTAL_KINDS)[number]

export interface TotalEntry {
  column: string
  kind: TotalKind
  /** Its aggregate's output name. */
  alias: string
}

/** The shown columns with a total, in order - each its aggregate's alias (`t0`, `t1`...). */
export function totalsPlan(fields: readonly DataViewField[]): TotalEntry[] {
  return fields
    .filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.visible && f.columnName && (TOTAL_KINDS as readonly unknown[]).includes((f.config as { total?: unknown } | undefined)?.total))
    .map((f, index) => ({ column: f.columnName!, kind: (f.config as { total: TotalKind }).total, alias: `t${index}` }))
}

/** The aggregates as the Data API reads them: `_sum[importe]=t0`. */
export function totalsParams(plan: readonly TotalEntry[]): Record<string, string> {
  return Object.fromEntries(plan.map(entry => [`_${entry.kind}[${entry.column}]`, entry.alias]))
}

/** The selected rows' sum of a column - what the selection bar adds up; null when none of them has a number there. */
export function selectionSum(rows: readonly Record<string, unknown>[], column: string): number | null {
  const values = rows.map(row => row[column]).filter(v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
  return values.length ? values.reduce<number>((sum, v) => sum + Number(v), 0) : null
}
