import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { columnOptions } from './dataview-columns'

const column = (patch: Partial<DataViewField>): DataViewField => ({
  id: '1', kind: 'COLUMN', parent: null, gridX: 0, gridY: 0, gridW: 12, gridH: 1, label: null, icon: null,
  columnAttnum: 2, columnName: 'fecha_alta', widget: 'UInputDate', visible: true, config: {}, relatedDataview: null, ...patch
})

// DataViews.md §15: a layout setting's columns read as the grid titles them - their table column's.
describe('columnOptions()', () => {
  it('titles each column by its table column\'s label, else its name humanized', () => {
    expect(columnOptions([
      column({ inherited: { label: 'Alta', shortLabel: 'Alta' } }),
      column({ id: '2', columnName: 'vence_el' }),
      column({ id: '3', kind: 'RELATED', columnName: 'cliente.razon_social' })
    ])).toEqual([
      { name: 'fecha_alta', label: 'Alta' },
      { name: 'vence_el', label: 'Vence El' },
      { name: 'cliente.razon_social', label: 'Cliente · Razon Social' }
    ])
  })
})
