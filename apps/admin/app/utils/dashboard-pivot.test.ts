import { describe, expect, it } from 'vitest'
import { buildPivot, compareDimension, pivotRowLabels, type PivotSpec } from './dashboard-pivot'

// Specification_Dashboards.md §5.17 (D17): the rows come aggregated by PostgreSQL - GROUPING SETS with __grouping
// (a bit per dimension, the leftmost the highest); the screen only places them.
describe('pivot placement', () => {
  const order: PivotSpec['order'] = column => (column === 'month' ? { kind: 'time' } : { kind: 'text' })
  // ROLLUP(branch, sex) × ROLLUP(month): 3 dimensions - branch 4, sex 2, month 1.
  const g = (branch: boolean, sex: boolean, month: boolean) => (branch ? 4 : 0) + (sex ? 2 : 0) + (month ? 1 : 0)
  const rows = [
    // Totals first, as the server orders them.
    { branch: null, sex: null, month: null, total: 1000, __grouping: g(true, true, true) },
    { branch: null, sex: null, month: '2026-01-01', total: 400, __grouping: g(true, true, false) },
    { branch: null, sex: null, month: '2026-02-01', total: 600, __grouping: g(true, true, false) },
    { branch: 'South', sex: null, month: null, total: 300, __grouping: g(false, true, true) },
    { branch: 'North', sex: null, month: null, total: 700, __grouping: g(false, true, true) },
    { branch: 'North', sex: null, month: '2026-02-01', total: 450, __grouping: g(false, true, false) },
    { branch: 'North', sex: null, month: '2026-01-01', total: 250, __grouping: g(false, true, false) },
    { branch: 'South', sex: null, month: '2026-01-01', total: 150, __grouping: g(false, true, false) },
    { branch: 'South', sex: null, month: '2026-02-01', total: 150, __grouping: g(false, true, false) },
    { branch: 'North', sex: 'F', month: null, total: 300, __grouping: g(false, false, true) },
    { branch: 'North', sex: 'M', month: null, total: 400, __grouping: g(false, false, true) },
    { branch: 'South', sex: 'F', month: null, total: 300, __grouping: g(false, false, true) },
    { branch: 'North', sex: 'F', month: '2026-01-01', total: 100, __grouping: g(false, false, false) },
    { branch: 'North', sex: 'F', month: '2026-02-01', total: 200, __grouping: g(false, false, false) },
    { branch: 'North', sex: 'M', month: '2026-01-01', total: 150, __grouping: g(false, false, false) },
    { branch: 'North', sex: 'M', month: '2026-02-01', total: 250, __grouping: g(false, false, false) },
    { branch: 'South', sex: 'F', month: '2026-01-01', total: 150, __grouping: g(false, false, false) },
    { branch: 'South', sex: 'F', month: '2026-02-01', total: 150, __grouping: g(false, false, false) }
  ]
  const spec: PivotSpec = { rows: ['branch', 'sex'], columns: ['month'], values: ['total'], order }
  const value = (cells: (Record<string, unknown> | undefined)[]) => cells.map(c => c?.total ?? null)

  it('places each group\'s rows, then its subtotal, the grand total last - every value PostgreSQL\'s', () => {
    const model = buildPivot(rows, spec)
    expect(model.leaves.map(l => (l.total ? 'total' : l.path[0]))).toEqual(['2026-01-01', '2026-02-01', 'total'])
    expect(model.rows.map(r => [r.kind, r.path, value(r.cells)])).toEqual([
      ['detail', ['North', 'F'], [100, 200, 300]],
      ['detail', ['North', 'M'], [150, 250, 400]],
      ['subtotal', ['North'], [250, 450, 700]],
      ['detail', ['South', 'F'], [150, 150, 300]],
      ['subtotal', ['South'], [150, 150, 300]],
      ['total', [], [400, 600, 1000]]
    ])
  })

  it('orders rows by a value\'s total when asked, groups and their members alike', () => {
    const model = buildPivot(rows, { ...spec, sortBy: { value: 'total', direction: 'DESC' } })
    expect(model.rows.map(r => r.path.join('/'))).toEqual(['North/M', 'North/F', 'North', 'South/F', 'South', ''])
  })

  it('without subtotals or totals, places only what the query returned', () => {
    const detail = rows.filter(r => r.__grouping === 0)
    const model = buildPivot(detail, spec)
    expect(model.leaves.some(l => l.total)).toBe(false)
    expect(model.rows.map(r => r.kind)).toEqual(['detail', 'detail', 'detail'])
    // A cell the query has no row for stays empty - never 0.
    const sparse = buildPivot(detail.filter(r => !(r.branch === 'South' && r.month === '2026-02-01')), spec)
    expect(value(sparse.rows[2]!.cells)).toEqual([150, null])
  })

  it('nests headers: Columns values × values, then the total', () => {
    const two = rows.map(r => ({ ...r, avg: Number(r.total) / 2 }))
    const model = buildPivot(two, { ...spec, values: ['total', 'avg'] })
    expect(model.headers.map(h => [h.kind, h.raw ?? null, h.children.map(c => c.column)])).toEqual([
      ['dimension', '2026-01-01', ['total', 'avg']],
      ['dimension', '2026-02-01', ['total', 'avg']],
      ['total', null, ['total', 'avg']]
    ])
    expect(model.leaves).toHaveLength(6)
  })

  it('with no Columns, a column per value', () => {
    const flat = [
      { branch: null, total: 10, __grouping: 1 },
      { branch: 'b', total: 4, __grouping: 0 },
      { branch: 'a', total: 6, __grouping: 0 }
    ]
    const model = buildPivot(flat, { rows: ['branch'], columns: [], values: ['total'], order })
    expect(model.headers.map(h => h.kind)).toEqual(['value'])
    expect(model.rows.map(r => [r.path[0] ?? null, value(r.cells)])).toEqual([['a', [6]], ['b', [4]], [null, [10]]])
    expect(pivotRowLabels(model.rows[2]!, 1, (_, raw) => String(raw), 'Total')).toEqual(['Total'])
  })

  it('orders text by its CHECK list, else alphabetically; time and numbers ascending; empty last', () => {
    expect(['LOW', 'HIGH', 'MID'].sort((a, b) => compareDimension(a, b, { kind: 'text', options: ['HIGH', 'MID', 'LOW'] }))).toEqual(['HIGH', 'MID', 'LOW'])
    expect(['b', null, 'a'].sort((a, b) => compareDimension(a, b, { kind: 'text' }))).toEqual(['a', 'b', null])
    expect([10, 9, 100].sort((a, b) => compareDimension(a, b, { kind: 'number' }))).toEqual([9, 10, 100])
  })
})
