import { describe, expect, it } from 'vitest'
import { buildHierarchy } from './dashboard-hierarchy'

// Specification_Dashboards.md §5.15 (D18): a tree by levels - a parent the sum of its children, a NULL ends the branch.
describe('hierarchy from level rows', () => {
  const rows = [
    { branch: 'North', category: 'Drinks', product: 'Water', sold: 120 },
    { branch: 'North', category: 'Drinks', product: 'Soda', sold: 90 },
    { branch: 'North', category: 'Food', product: 'Bread', sold: 60 },
    { branch: 'South', category: 'Drinks', product: 'Water', sold: 70 },
    { branch: 'North', category: null, product: 'Gift', sold: 15 }
  ]
  const tree = buildHierarchy(rows, ['branch', 'category', 'product'], 'sold', Number)

  it('sums children into their parents, in the query\'s order', () => {
    expect(tree.map(n => [n.raw, n.value])).toEqual([['North', 285], ['South', 70]])
    expect(tree[0]!.children.map(n => [n.raw, n.value])).toEqual([['Drinks', 210], ['Food', 60]])
    expect(tree[0]!.children[0]!.children.map(n => [n.raw, n.value, n.rows])).toEqual([['Water', 120, [0]], ['Soda', 90, [1]]])
  })

  it('hangs a row whose level is NULL on the node above it', () => {
    const north = tree[0]!
    expect(north.own).toBe(15)
    expect(north.rows).toEqual([4])
    expect(north.children.some(c => c.raw === null)).toBe(false)
  })

  it('keeps each node\'s path - what a click hands its card', () => {
    expect(tree[0]!.children[1]!.children[0]!.path).toEqual(['North', 'Food', 'Bread'])
  })
})
