/**
 * Bindings v2's `value` binding (record-engine.ts's own doc
 * comment) - unlike every other bindable property (label/visible/etc,
 * which only ever override a STATIC default and never depend on each
 * OTHER binding), `value` bindings can chain: `subtotal = {{cantidad}}
 * * {{precio}}`, `total = {{subtotal}} + {{impuesto}}`. This orders
 * them so `subtotal` is always computed before `total` reads it, and
 * rejects a formula chain that depends on itself (directly or through
 * others) - "A depends on B, B depends on A".
 *
 * Standard DFS-based topological sort with 3-color marking (white =
 * unvisited, gray = on the current recursion stack, black = fully
 * resolved) - a gray node revisited mid-recursion IS the cycle. Only
 * ~20 nodes at most per DataView (one per COLUMN field), so no need
 * for anything fancier than plain recursion.
 */
export interface ValueBindingGraphResult {
  /** Column names with a `value` binding, in the order they must be (re)computed - dependencies always before the fields that read them. Empty when `cycle` is set. */
  order: string[]
  /** Set only when a cycle was found - the chain that closes it (e.g. `['total', 'subtotal', 'total']`), for a friendly error message. `order` is empty in that case - nothing is safe to compute until the cycle is fixed. */
  cycle?: string[]
}

/**
 * `bindings`: every COLUMN field's own `value` formula, keyed by column
 * name - ONLY fields that actually have one (a plain input column
 * doesn't belong in this map at all, it's a leaf dependency, not a node
 * to order). `dependenciesOf` extracts the `{{col}}` references from
 * each formula (`formula-engine.ts`'s own `formulaDependencies`) -
 * passed in rather than called here so this stays a pure graph
 * algorithm, easy to unit test without a full formula string per edge.
 */
export function orderValueBindings(bindings: Record<string, string>, dependenciesOf: (formula: string) => Set<string>): ValueBindingGraphResult {
  const deps = new Map<string, Set<string>>()
  for (const [column, formula] of Object.entries(bindings)) {
    deps.set(column, dependenciesOf(formula))
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const order: string[] = []
  let cycle: string[] | undefined

  function visit(node: string, path: string[]): boolean {
    color.set(node, GRAY)
    path.push(node)
    for (const dep of deps.get(node) ?? []) {
      if (!deps.has(dep)) continue // a plain input column, not another computed field - nothing to order it against
      const depColor = color.get(dep) ?? WHITE
      if (depColor === GRAY) {
        cycle = [...path, dep]
        return false
      }
      if (depColor === WHITE && !visit(dep, path)) return false
    }
    path.pop()
    color.set(node, BLACK)
    // Post-order: every dependency this node has is already pushed to
    // `order` by the time this line runs (the recursive `visit` calls
    // just above always finish first) - so `order` comes out with
    // dependencies before dependents, no separate reverse step needed.
    order.push(node)
    return true
  }

  for (const column of deps.keys()) {
    if ((color.get(column) ?? WHITE) === WHITE && !visit(column, [])) {
      return { order: [], cycle }
    }
  }
  return { order }
}
