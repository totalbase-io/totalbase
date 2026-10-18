/**
 * A TREEMAP's or a SUNBURST's tree (Specification_Dashboards.md §5.15, D18), built from its rows by levels: each row
 * a path down its Levels columns (outermost first) to its value. A parent is the sum of its children (the guide asks
 * for summable values only); a NULL level ends the branch there - the row's value hangs on the node above it. Pure:
 * names, colors and formats are its builder's.
 */

export interface HierarchyNode {
  /** Its own level's value, as the query returned it. */
  raw: unknown
  /** The level it is on - 0 the outermost. */
  depth: number
  /** Every level's value from the top down to it. */
  path: unknown[]
  /** Its children's values plus what hangs on it directly (a row whose next level is NULL). */
  value: number
  /** What hangs on it directly. */
  own: number
  children: HierarchyNode[]
  /** The rows that end on it, in the query's order - a leaf's own row is its last. */
  rows: number[]
}

const isEmpty = (value: unknown) => value === null || value === undefined

/**
 * The tree of `rows` by `levels`, siblings in the order the query first returns them. A row whose first level is NULL
 * is a top node of its own (its empty value) - a value never goes missing.
 */
export function buildHierarchy(rows: readonly Record<string, unknown>[], levels: readonly string[], value: string, toNumber: (raw: unknown) => number): HierarchyNode[] {
  const roots: HierarchyNode[] = []
  const index = new Map<string, HierarchyNode>()
  rows.forEach((row, rowIndex) => {
    const amount = toNumber(row[value])
    let siblings = roots
    let parent: HierarchyNode | null = null
    const path: unknown[] = []
    for (let depth = 0; depth < levels.length; depth++) {
      const raw = row[levels[depth]!]
      // A NULL level ends the branch: the value hangs on the node above (the top one keeps its empty value).
      if (isEmpty(raw) && depth > 0) break
      path.push(raw)
      const key = JSON.stringify(path)
      let node = index.get(key)
      if (!node) {
        node = { raw, depth, path: [...path], value: 0, own: 0, children: [], rows: [] }
        index.set(key, node)
        siblings.push(node)
      }
      node.value += amount
      parent = node
      siblings = node.children
    }
    if (parent) {
      parent.rows.push(rowIndex)
      // A row that ended above the last level (a NULL) hangs on it directly.
      if (parent.depth < levels.length - 1) parent.own += amount
    }
  })
  return roots
}

/** Every node, depth first (a parent before its children). */
export function flattenHierarchy(nodes: readonly HierarchyNode[]): HierarchyNode[] {
  return nodes.flatMap(node => [node, ...flattenHierarchy(node.children)])
}
