/**
 * How placed widgets lay out (DataViews.md §12.2):
 * every area - the page itself, or one slot of a widget - is an ordered list
 * in flow, wrapped into rows of 12 columns; each widget has an order
 * (`gridY`) and a width (`gridW`), each row is as tall as its tallest widget,
 * and a phone stacks them. Only a `sizable` widget has a height of its own,
 * in rows (`gridH`).
 */
import type { DataViewField } from '~/types/dataview'

/** The canvas's row, for a sizable widget's height. */
export const LAYOUT_ROW_PX = 40
/** A sizable widget placed without a height yet. */
export const DEFAULT_SIZABLE_ROWS = 6

/**
 * The fields of a page, indexed: by id, by parent, and by area (parent +
 * slot), each area's widgets already in order. Built once per fields
 * array and cached on it (a WeakMap): every area, every canvas item and
 * every renderer of a CUSTOM page asks for its own children, and before
 * this each one filtered the whole list - on a page of N widgets, N scans
 * of N on every inspector keystroke. A changed page is a new array
 * (`localFields.value = localFields.value.map(...)`, a computed's
 * `.filter(...)`), so the cache never outlives the fields it indexes;
 * nothing mutates a fields array in place, and nothing may start to.
 */
export interface FieldIndex {
  byId: Map<string, DataViewField>
  /** A parent's widgets in every slot (the page's under `null`), unordered. */
  children: Map<string | null, DataViewField[]>
  /** One area's widgets in order - `areaKey()` is the key. */
  byArea: Map<string, DataViewField[]>
}

const FIELD_INDEXES = new WeakMap<readonly DataViewField[], FieldIndex>()

function areaKey(parent: string | null, slot: string | undefined): string {
  return `${parent ?? ''}\u0000${slot ?? ''}`
}

export function fieldIndex(fields: readonly DataViewField[]): FieldIndex {
  const cached = FIELD_INDEXES.get(fields)
  if (cached) return cached
  const index: FieldIndex = { byId: new Map(), children: new Map(), byArea: new Map() }
  for (const field of fields) {
    index.byId.set(field.id, field)
    if (field.kind !== 'WIDGET') continue
    const siblings = index.children.get(field.parent)
    if (siblings) siblings.push(field)
    else index.children.set(field.parent, [field])
    const key = areaKey(field.parent, (field.config as { slot?: string }).slot)
    const area = index.byArea.get(key)
    if (area) area.push(field)
    else index.byArea.set(key, [field])
  }
  for (const area of index.byArea.values()) area.sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX)
  FIELD_INDEXES.set(fields, index)
  return index
}

const NO_FIELDS: readonly DataViewField[] = []

/** The widgets of one area, in order - `parent` null is the page itself, or with `PAGE_HEADER_SLOT`/`PAGE_FOOTER_SLOT` its header or its footer. Shared with every other caller: read it, never change it. */
export function areaWidgets(fields: readonly DataViewField[], parent: string | null, slot: string | undefined): readonly DataViewField[] {
  return fieldIndex(fields).byArea.get(areaKey(parent, slot)) ?? NO_FIELDS
}

/** A parent's widgets, whatever their slot - the page's for `null`. Shared like `areaWidgets()`'s. */
export function childWidgets(fields: readonly DataViewField[], parent: string | null): readonly DataViewField[] {
  return fieldIndex(fields).children.get(parent) ?? NO_FIELDS
}

/** A field by its id, through the same index. */
export function fieldById(fields: readonly DataViewField[], id: string | null | undefined): DataViewField | undefined {
  return id ? fieldIndex(fields).byId.get(id) : undefined
}

/** Whether a slot area holds anything - for a per-item slot, any of its items' areas. */
export function slotHasWidgets(fields: readonly DataViewField[], parent: string, slot: string, perItem: boolean): boolean {
  return childWidgets(fields, parent).some(f => ((f.config as { slot?: string }).slot === slot || (perItem && ((f.config as { slot?: string }).slot ?? '').startsWith(`${slot}:`))))
}

/** A widget's width in its area's row; a phone stacks them (see `.widget-area`). */
export function widgetCellStyle(field: DataViewField): Record<string, string> {
  const span = Math.min(12, Math.max(1, field.gridW || 12))
  return { 'grid-column': `span ${span} / span ${span}` }
}

/** A sizable widget's height, in pixels. */
export function sizableHeight(field: DataViewField): number {
  return (field.gridH > 1 ? field.gridH : DEFAULT_SIZABLE_ROWS) * LAYOUT_ROW_PX
}

/** A sizable widget's height bounds, in rows. */
export const SIZABLE_ROWS = { min: 2, max: 30 }

interface Box { left: number, top: number, width: number, height: number }
/**
 * Where a drop at (x, y) lands among an area's widgets, laid out in rows:
 * before the first widget the pointer is above, or beside in its left half;
 * after them all otherwise.
 */
export function dropIndex(boxes: readonly Box[], x: number, y: number): number {
  const index = boxes.findIndex(box => y < box.top || (y <= box.top + box.height && x < box.left + box.width / 2))
  return index === -1 ? boxes.length : index
}

/**
 * The column shortcuts - the canvas toolbar lays an area out in N even
 * columns, a widget's menu sets that one widget's width. 12 divides by
 * each, so a row always fills.
 */
export const COLUMN_LAYOUTS = [
  { columns: 1, width: 12, label: '1 column', icon: 'i-lucide-rows-2' },
  { columns: 2, width: 6, label: '2 columns', icon: 'i-lucide-columns-2' },
  { columns: 3, width: 4, label: '3 columns', icon: 'i-lucide-columns-3' },
  { columns: 4, width: 3, label: '4 columns', icon: 'i-lucide-columns-4' }
] as const
