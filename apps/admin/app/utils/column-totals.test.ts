import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { selectionSum, totalsParams, totalsPlan } from '~/utils/column-totals'

const field = (columnName: string, config: Record<string, unknown>, visible = true) => ({ id: columnName, kind: 'COLUMN', columnName, visible, config }) as unknown as DataViewField

// A grid's totals (DataViews.md §4.9, T73).
describe('column totals', () => {
  it('asks PostgreSQL for each column\'s total, as the Data API\'s aggregates', () => {
    const plan = totalsPlan([field('importe', { total: 'sum' }), field('cliente', {}), field('pagado', { total: 'avg' })])
    expect(plan).toEqual([{ column: 'importe', kind: 'sum', alias: 't0' }, { column: 'pagado', kind: 'avg', alias: 't1' }])
    expect(totalsParams(plan)).toEqual({ '_sum[importe]': 't0', '_avg[pagado]': 't1' })
  })

  // The grid hands it the columns the viewer shows (DataViews.md §4.1): a column the DataView hides that the
  // viewer showed from the Columns panel has its total; one the viewer hid is not among them to begin with.
  it('totals a column the DataView hides when the viewer shows it - `visible` is only that preference\'s default', () => {
    const plan = totalsPlan([field('importe', { total: 'sum' }), field('oculto', { total: 'sum' }, false)])
    expect(plan).toEqual([{ column: 'importe', kind: 'sum', alias: 't0' }, { column: 'oculto', kind: 'sum', alias: 't1' }])
  })

  it('adds up the selection - numbers as the API sends them, text included', () => {
    expect(selectionSum([{ importe: '1000.50' }, { importe: 500 }, { importe: null }], 'importe')).toBe(1500.5)
    expect(selectionSum([{ importe: null }], 'importe')).toBeNull()
  })
})
