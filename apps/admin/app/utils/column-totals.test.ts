import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { selectionSum, totalsParams, totalsPlan } from '~/utils/column-totals'

const field = (columnName: string, config: Record<string, unknown>, visible = true) => ({ id: columnName, kind: 'COLUMN', columnName, visible, config }) as unknown as DataViewField

// A grid's totals (Specification_DataViews.md §4.9, T73).
describe('column totals', () => {
  it('asks PostgreSQL for each shown column\'s total, as the Data API\'s aggregates', () => {
    const plan = totalsPlan([field('importe', { total: 'sum' }), field('cliente', {}), field('pagado', { total: 'avg' }), field('oculto', { total: 'sum' }, false)])
    expect(plan).toEqual([{ column: 'importe', kind: 'sum', alias: 't0' }, { column: 'pagado', kind: 'avg', alias: 't1' }])
    expect(totalsParams(plan)).toEqual({ '_sum[importe]': 't0', '_avg[pagado]': 't1' })
  })

  it('adds up the selection - numbers as the API sends them, text included', () => {
    expect(selectionSum([{ importe: '1000.50' }, { importe: 500 }, { importe: null }], 'importe')).toBe(1500.5)
    expect(selectionSum([{ importe: null }], 'importe')).toBeNull()
  })
})
