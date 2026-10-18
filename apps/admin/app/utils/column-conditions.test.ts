import { describe, expect, it } from 'vitest'
import { cardMark, conditionPlan, flagsByRow, rowLook } from '~/utils/column-conditions'

// Specification_DataViews.md §15.7: PostgreSQL says which conditions a row meets; the first that holds wins.
describe('conditional formatting', () => {
  const plan = conditionPlan([
    { column: 'stock', conditions: [
      { name: 'Out', where: { stock: { _lte: '0' } }, style: { color: 'red' } },
      { name: 'Low', where: { stock: { _lt: '$ROW.minimo' } }, style: { color: 'amber' } },
      { name: 'Off', enabled: false, where: { stock: { _gt: '0' } }, style: { bold: true } }
    ] },
    { column: 'estado', conditions: [{ name: 'Anulada', applyTo: 'row', where: { estado: { _eq: 'ANULADA' } }, style: { strike: true, dim: true } }] }
  ])

  it('sends every enabled condition as one flag, in order', () => {
    expect(Object.keys(plan.flags)).toEqual(['c0', 'c1', 'c2'])
    expect(plan.flags.c1).toEqual({ stock: { _lt: '$ROW.minimo' } })
  })

  it('takes the first condition that holds per cell, and the row\'s', () => {
    const look = rowLook(['c1', 'c0', 'c2'], plan)
    expect(look.cells.stock).toEqual({ color: 'red' })
    expect(look.row).toEqual({ strike: true, dim: true })
    expect(rowLook([], plan)).toEqual({ cells: {}, row: null })
  })

  it('reads meta.flags by row, and marks a card by its row condition', () => {
    const rows = [{ id: 1 }, { id: 2 }]
    const met = flagsByRow(rows, [['c0'], []])
    expect(met.get(rows[0]!)).toEqual(['c0'])
    expect(cardMark({ background: 'amber', dim: true }, c => `shade-${c}`)).toEqual({ color: 'shade-amber', dim: true })
    expect(cardMark(null, c => c)).toBeNull()
  })
})
