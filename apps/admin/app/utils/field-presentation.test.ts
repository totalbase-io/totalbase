import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { resolveFieldPresentation } from './field-presentation'

const column = (patch: Partial<DataViewField>): DataViewField => ({
  id: '1', kind: 'COLUMN', parent: null, gridX: 0, gridY: 0, gridW: 12, gridH: 1, label: null, icon: null,
  columnAttnum: 2, columnName: 'precio_unitario', widget: 'UInputNumber', visible: true, config: {}, relatedDataview: null, ...patch
})

// Specification_DataViews.md §15: a grid column inherits from its resource's column.
describe('resolveFieldPresentation()', () => {
  it('titles a column by its table column\'s, else its name humanized - never a title of its own', () => {
    expect(resolveFieldPresentation(column({ inherited: { label: 'Precio unitario' } })).label).toBe('Precio unitario')
    expect(resolveFieldPresentation(column({})).label).toBe('Precio Unitario')
    expect(resolveFieldPresentation(column({ kind: 'RELATED', columnName: 'producto.codigo' })).label).toBe('Producto · Codigo')
    expect(resolveFieldPresentation(column({ label: 'Viejo', inherited: { label: 'Precio unitario' } })).label).toBe('Precio unitario')
  })

  it('shows its table column\'s display options, look and conditions, with what its list does - never a form-only key', () => {
    const condition = { name: 'Bajo', where: { precio_unitario: { _lt: 10 } }, style: { color: 'red' as const } }
    const resolved = resolveFieldPresentation(column({
      config: { truncate: true, required: true },
      inherited: { displayFormat: '#,##0.00', bold: true, help: 'Sin IVA', placeholder: '0', conditions: [condition] }
    }))
    expect(resolved.config).toEqual({ displayFormat: '#,##0.00', bold: true, truncate: true, required: true, conditions: [condition] })
  })

  it('heads a list by the column\'s short label', () => {
    expect(resolveFieldPresentation(column({ inherited: { label: 'Precio unitario', shortLabel: 'P. unit.' } })).config).toEqual({ shortLabel: 'P. unit.' })
  })

  it('leaves a page widget alone', () => {
    const widget = column({ kind: 'WIDGET', columnName: null, widget: 'UButton', inherited: { label: 'x' } })
    expect(resolveFieldPresentation(widget)).toBe(widget)
  })
})
