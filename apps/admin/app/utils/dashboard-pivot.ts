/**
 * A PIVOT's grid (Specification_Dashboards.md §5.17, D17), placed from rows PostgreSQL already aggregated: the
 * server wraps the query in `GROUP BY GROUPING SETS` and marks each row with `__grouping` = GROUPING(rows...,
 * columns...) - a bit per dimension, the leftmost the highest, set where the row totals that dimension. This only
 * places each row's values in their cell: a subtotal or a total is PostgreSQL's row, never a sum made here.
 */

/** The grouping flag's column - the server's `PIVOT_GROUPING_COLUMN`. */
export const PIVOT_GROUPING_COLUMN = '__grouping'
/** A total column's key among the cells. */
const TOTAL_KEY = '__total'

/** How a dimension's values are ordered: time and numbers ascending, text by its CHECK list's order, else alphabetical. */
export interface DimensionOrder {
  kind: 'time' | 'number' | 'text'
  /** Its CHECK list, in order (its presentation's `options`). */
  options?: readonly string[]
}

export interface PivotSpec {
  /** The Rows role's columns, outermost first. */
  rows: readonly string[]
  /** The Columns role's columns - none: one column per value. */
  columns: readonly string[]
  values: readonly string[]
  /** Rows ordered by a value's total (its row total; with no Columns, its own value) - else by their own values. */
  sortBy?: { value: string, direction?: 'ASC' | 'DESC' } | null
  order: (column: string) => DimensionOrder
}

/** One column of values: a value under one combination of the Columns' values - or under their total. */
export interface PivotLeaf {
  key: string
  /** The Columns' values it sits under (none for a total, or with no Columns). */
  path: unknown[]
  total: boolean
  /** The value column it shows. */
  value: string
}

/** The nested header: a Columns value, the total, or a value's title - a leaf has no children. */
export interface PivotHeader {
  id: string
  kind: 'dimension' | 'total' | 'value'
  /** A dimension's column, or a value's column. */
  column?: string
  raw?: unknown
  children: PivotHeader[]
  leaf?: PivotLeaf
}

export interface PivotRow {
  /** detail: every row level set; subtotal: some; total: none (the grand total). */
  kind: 'detail' | 'subtotal' | 'total'
  /** How many row levels it has - a detail row all of them. */
  level: number
  /** Its row levels' values, outermost first (`level` of them). */
  path: unknown[]
  /** Each leaf's result row (aligned with `leaves`) - its value is `cells[i][leaf.value]`; undefined: an empty cell. */
  cells: (Record<string, unknown> | undefined)[]
}

export interface PivotModel {
  leaves: PivotLeaf[]
  headers: PivotHeader[]
  rows: PivotRow[]
}

const isEmpty = (value: unknown) => value === null || value === undefined

/** Two values of one dimension, by its order - an empty value last. */
export function compareDimension(a: unknown, b: unknown, order: DimensionOrder): number {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) === isEmpty(b) ? 0 : isEmpty(a) ? 1 : -1
  if (order.kind === 'number') return Number(a) - Number(b)
  if (order.kind === 'time') return new Date(String(a)).getTime() - new Date(String(b)).getTime()
  if (order.options?.length) {
    const at = (value: unknown) => {
      const index = order.options!.indexOf(String(value))
      return index === -1 ? Number.MAX_SAFE_INTEGER : index
    }
    const byList = at(a) - at(b)
    if (byList !== 0) return byList
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

function comparePaths(a: readonly unknown[], b: readonly unknown[], columns: readonly string[], order: PivotSpec['order']): number {
  for (let i = 0; i < columns.length; i++) {
    const compared = compareDimension(a[i], b[i], order(columns[i]!))
    if (compared !== 0) return compared
  }
  return 0
}

interface RowNode {
  level: number
  path: unknown[]
  /** Its aggregated rows by column key - none for a level the query has no subtotal of. */
  cells: Map<string, Record<string, unknown>>
  children: Map<string, RowNode>
}

/** The grid of an aggregated result: its value columns (headers nested Columns × values) and its rows, totals placed. */
export function buildPivot(resultRows: readonly Record<string, unknown>[], spec: PivotSpec): PivotModel {
  const { rows: rowDims, columns: columnDims, values } = spec
  const dimensions = rowDims.length + columnDims.length
  const isSet = (grouping: number, index: number) => (grouping & (1 << (dimensions - 1 - index))) !== 0

  const root: RowNode = { level: 0, path: [], cells: new Map(), children: new Map() }
  const columnPaths = new Map<string, unknown[]>()
  let anyColumnTotal = false

  for (const row of resultRows) {
    const grouping = Number(row[PIVOT_GROUPING_COLUMN] ?? 0) || 0
    let level = rowDims.length
    for (let i = 0; i < rowDims.length; i++) {
      if (isSet(grouping, i)) {
        level = i
        break
      }
    }
    const columnTotal = columnDims.some((_, i) => isSet(grouping, rowDims.length + i))
    let columnKey: string
    if (columnTotal) {
      columnKey = TOTAL_KEY
      anyColumnTotal = true
    } else {
      const path = columnDims.map(c => row[c])
      columnKey = JSON.stringify(path)
      if (!columnPaths.has(columnKey)) columnPaths.set(columnKey, path)
    }
    // Its node, its parents made on the way (a level without subtotals has none of its own rows).
    let node = root
    for (let depth = 0; depth < level; depth++) {
      const raw = row[rowDims[depth]!]
      const key = JSON.stringify(raw ?? null)
      let child = node.children.get(key)
      if (!child) {
        child = { level: depth + 1, path: [...node.path, raw], cells: new Map(), children: new Map() }
        node.children.set(key, child)
      }
      node = child
    }
    node.cells.set(columnKey, row)
  }

  // The value columns: each combination of the Columns' values in order, then their total.
  const paths = [...columnPaths.values()].sort((a, b) => comparePaths(a, b, columnDims, spec.order))
  const leaves: PivotLeaf[] = []
  for (const path of paths) {
    for (const value of values) leaves.push({ key: `${JSON.stringify(path)}|${value}`, path, total: false, value })
  }
  if (anyColumnTotal && columnDims.length > 0) {
    for (const value of values) leaves.push({ key: `${TOTAL_KEY}|${value}`, path: [], total: true, value })
  }
  const cellKey = (leaf: PivotLeaf) => (leaf.total ? TOTAL_KEY : JSON.stringify(leaf.path))

  // Siblings: by the chosen value's total, else by their own values.
  const sortValue = spec.sortBy && values.includes(spec.sortBy.value) ? spec.sortBy.value : null
  const direction = spec.sortBy?.direction === 'DESC' ? -1 : 1
  const totalKey = columnDims.length > 0 ? TOTAL_KEY : JSON.stringify([])
  const amount = (node: RowNode): number | null => {
    const raw = sortValue ? node.cells.get(totalKey)?.[sortValue] : undefined
    if (isEmpty(raw)) return null
    const number = Number(raw)
    return Number.isFinite(number) ? number : null
  }
  const ordered = (node: RowNode): RowNode[] => {
    const children = [...node.children.values()]
    const dimension = rowDims[node.level]!
    return children.sort((a, b) => {
      if (sortValue) {
        const x = amount(a)
        const y = amount(b)
        if (x !== null && y !== null && x !== y) return direction * (x - y)
        if ((x === null) !== (y === null)) return x === null ? 1 : -1
      }
      return compareDimension(a.path[node.level], b.path[node.level], spec.order(dimension))
    })
  }

  const rows: PivotRow[] = []
  const toRow = (node: RowNode): PivotRow => ({
    kind: node.level === rowDims.length ? 'detail' : node.level === 0 ? 'total' : 'subtotal',
    level: node.level,
    path: node.path,
    cells: leaves.map(leaf => node.cells.get(cellKey(leaf)))
  })
  // Each group's rows, then its subtotal; the grand total last.
  const walk = (node: RowNode) => {
    for (const child of ordered(node)) {
      if (child.level === rowDims.length) rows.push(toRow(child))
      else {
        walk(child)
        if (child.cells.size > 0) rows.push(toRow(child))
      }
    }
  }
  walk(root)
  if (root.cells.size > 0) rows.push(toRow(root))

  return { leaves, headers: pivotHeaders(leaves, columnDims, values), rows }
}

/** The nested header over the leaves: a level per Columns column, then the values (one value alone needs no row of its own). */
function pivotHeaders(leaves: readonly PivotLeaf[], columnDims: readonly string[], values: readonly string[]): PivotHeader[] {
  const several = values.length > 1
  const valueNodes = (group: readonly PivotLeaf[], prefix: string): PivotHeader[] =>
    group.map(leaf => ({ id: `${prefix}|${leaf.value}`, kind: 'value', column: leaf.value, children: [], leaf }))
  if (columnDims.length === 0) return valueNodes(leaves, 'v')
  const level = (group: readonly PivotLeaf[], depth: number, prefix: string): PivotHeader[] => {
    const nodes: PivotHeader[] = []
    let start = 0
    while (start < group.length) {
      const raw = group[start]!.path[depth]
      let end = start
      while (end < group.length && JSON.stringify(group[end]!.path[depth] ?? null) === JSON.stringify(raw ?? null)) end++
      const slice = group.slice(start, end)
      const id = `${prefix}|${JSON.stringify(raw ?? null)}`
      const last = depth === columnDims.length - 1
      const node: PivotHeader = { id, kind: 'dimension', column: columnDims[depth], raw, children: [] }
      if (!last) node.children = level(slice, depth + 1, id)
      else if (several) node.children = valueNodes(slice, id)
      else node.leaf = slice[0]
      nodes.push(node)
      start = end
    }
    return nodes
  }
  const detail = leaves.filter(l => !l.total)
  const totals = leaves.filter(l => l.total)
  const headers = level(detail, 0, 'c')
  if (totals.length) headers.push(several ? { id: 't', kind: 'total', children: valueNodes(totals, 't') } : { id: 't', kind: 'total', children: [], leaf: totals[0] })
  return headers
}

/** A row's text down its row levels: its values, then "Total" where its subtotal starts (the grand total's first). */
export function pivotRowLabels(row: PivotRow, levels: number, dimension: (index: number, raw: unknown) => string, total: string): string[] {
  return Array.from({ length: levels }, (_, i) => (i < row.level ? dimension(i, row.path[i]) : i === row.level ? total : ''))
}
