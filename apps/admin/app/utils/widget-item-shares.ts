/**
 * Items that share a whole (DataViews.md §12.4.1): a Splitter's panels their
 * size in % of 100, a Columns' columns their width in the row's 12 columns.
 * `reshare` sets one item's share and gives the change to the others in
 * proportion to what they had, none under its minimum, so the shares always
 * sum to the whole.
 */
import type { WidgetItem, WidgetItemField } from '@totalbase/tb-catalog'

export interface ShareField {
  /** The item field that holds the share. */
  key: 'defaultSize' | 'span'
  /** What the shares sum to. */
  total: number
  /** An item's smallest share. */
  min: (item: WidgetItem) => number
}

/** The share an items editor's fields carry, if any: a Splitter's `size`, a Columns' `span`. */
export function shareField(fields: readonly WidgetItemField[]): ShareField | null {
  if (fields.includes('size')) return { key: 'defaultSize', total: 100, min: item => Math.max(0, Math.min(100, item.minSize ?? 0)) }
  if (fields.includes('span')) return { key: 'span', total: 12, min: () => 1 }
  return null
}

/** The items with item `index`'s share set to `value` and the rest reshared - never under a minimum, the last other item taking the remainder. */
export function reshare(items: readonly WidgetItem[], index: number, value: number, field: ShareField): WidgetItem[] {
  const next = items.map(item => ({ ...item }))
  const target = next[index]
  if (!target) return next
  const others = next.filter((_, i) => i !== index)
  const get = (item: WidgetItem) => Math.max(item[field.key] ?? 0, 0)
  const share = Math.max(field.min(target), Math.min(field.total - others.reduce((sum, o) => sum + field.min(o), 0), Math.round(value)))
  target[field.key] = share
  const remaining = field.total - share
  const weights = others.map(get)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  others.forEach((o, i) => {
    const part = totalWeight > 0 ? Math.round(remaining * (weights[i]! / totalWeight)) : Math.round(remaining / others.length)
    o[field.key] = Math.max(field.min(o), part)
  })
  // Rounding and minimums leave a remainder: the last other item takes it.
  const sum = next.reduce((a, item) => a + (item[field.key] ?? 0), 0)
  const last = others[others.length - 1]
  if (last && sum !== field.total) last[field.key] = Math.max(field.min(last), (last[field.key] ?? 0) + (field.total - sum))
  return next
}

/** What the items' shares sum to. */
export function shareSum(items: readonly WidgetItem[], field: ShareField): number {
  return items.reduce((a, item) => a + (item[field.key] ?? 0), 0)
}
