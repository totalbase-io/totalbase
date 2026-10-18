/**
 * Conditional formatting (Specification_DataViews.md §15.7): a list's columns' conditions sent as the Data API's
 * `flags` (§3.11 there) - PostgreSQL says which each row meets, the browser never evaluates them - and, from what it
 * answered, each cell's and each row's look: the first condition that holds wins, per cell and per row (a cell's over
 * a row's), on top of the base style.
 */
import type { ColumnCondition, ConditionStyle } from '@totalbase/tb-catalog'
import { backgroundTint, setCellStyleClass } from '~/utils/table-column-style'

/** One column and its conditions, in the list's column order. */
export interface ConditionedColumn {
  column: string
  conditions?: readonly ColumnCondition[]
}

/** What a list asks for and how to read the answer: the `flags` query object and, per flag, its column and condition. */
export interface ConditionPlan {
  /** `{ c0: where, c1: where... }` - the request's `flags`; empty when there's nothing to evaluate. */
  flags: Record<string, Record<string, unknown>>
  entries: { flag: string, column: string, condition: ColumnCondition }[]
}

/** The Data API's cap on flags in one request. */
export const MAX_FLAGS = 32

/** Every enabled condition of every column, in order, as one flag each (`c0`, `c1`...) - at most `budget` (what custom actions' flags leave). */
export function conditionPlan(columns: readonly ConditionedColumn[], budget = MAX_FLAGS): ConditionPlan {
  const flags: Record<string, Record<string, unknown>> = {}
  const entries: ConditionPlan['entries'] = []
  for (const { column, conditions } of columns) {
    for (const condition of conditions ?? []) {
      if (condition.enabled === false || entries.length >= budget) continue
      const flag = `c${entries.length}`
      flags[flag] = condition.where
      entries.push({ flag, column, condition })
    }
  }
  return { flags, entries }
}

/** A row's look: the condition style of each of its cells that one holds for, and its row's. */
export interface RowLook {
  cells: Record<string, ConditionStyle>
  row: ConditionStyle | null
}

/** From the flags a row met: the first cell condition per column, the first row condition. */
export function rowLook(met: readonly string[] | undefined, plan: ConditionPlan): RowLook {
  const look: RowLook = { cells: {}, row: null }
  if (!met?.length) return look
  for (const entry of plan.entries) {
    if (!met.includes(entry.flag)) continue
    if (entry.condition.applyTo === 'row') look.row ??= entry.condition.style
    else look.cells[entry.column] ??= entry.condition.style
  }
  return look
}

/** A condition's look as classes and inline style - its colors shaded for the mode (`shade`). */
export function conditionStyleAttrs(style: ConditionStyle, shade: (color: string) => string | undefined): { class: string, style: Record<string, string> } {
  const color = style.color ? shade(style.color) : undefined
  const background = style.background ? backgroundTint(shade(style.background)) : undefined
  return {
    class: [setCellStyleClass(style), style.dim ? 'opacity-50' : ''].filter(Boolean).join(' '),
    style: { ...(color ? { color } : {}), ...(background ? { backgroundColor: background } : {}) }
  }
}

/** The rows' flags, by row - `meta.flags` is in `data`'s order. */
export function flagsByRow(rows: readonly Record<string, unknown>[], flags: readonly string[][] | undefined): WeakMap<Record<string, unknown>, string[]> {
  const map = new WeakMap<Record<string, unknown>, string[]>()
  if (!flags) return map
  rows.forEach((row, index) => map.set(row, flags[index] ?? []))
  return map
}

/** A card a row condition holds for: a colored edge (its color, else its background) and dimmed - Cards, Kanban. */
export interface CardMark {
  color?: string
  dim?: boolean
}
export function cardMark(style: ConditionStyle | null | undefined, shade: (color: string) => string | undefined): CardMark | null {
  if (!style) return null
  const color = style.color ? shade(style.color) : style.background ? shade(style.background) : undefined
  return color || style.dim ? { ...(color ? { color } : {}), ...(style.dim ? { dim: true } : {}) } : null
}
/** A card's mark as attributes - its left edge colored, its look dimmed. */
export function cardMarkAttrs(mark: CardMark | null | undefined): { class?: string, style?: Record<string, string> } {
  if (!mark) return {}
  return {
    class: [mark.color ? 'border-l-4' : '', mark.dim ? 'opacity-50' : ''].filter(Boolean).join(' '),
    style: mark.color ? { borderLeftColor: mark.color } : {}
  }
}
