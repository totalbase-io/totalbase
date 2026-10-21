import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { formEditableColumns } from '~/utils/form-editable-columns'

let next = 0
const widget = (widget: string, config: Record<string, unknown>, parent: string | null, gridY: number, gridX = 0) =>
  ({ id: `w${next++}`, kind: 'WIDGET', widget, parent, gridX, gridY, gridW: 6, gridH: 1, visible: true, config }) as unknown as DataViewField
function formField(column: string, gridY: number, gridX = 0, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  const field = widget('UFormField', { props: { column, ...(extra.props as object ?? {}) }, ...(extra.bindings ? { bindings: extra.bindings } : {}) }, null, gridY, gridX)
  return [field, widget('UInput', { slot: 'default', ...input }, field.id, 0)]
}

// What a bulk edit offers (DataViews.md §5.15).
describe('formEditableColumns()', () => {
  it('lists the form\'s editable fields in its order, titled as the form titles them', () => {
    const fields = [
      ...formField('sexo', 1, 6),
      ...formField('apellido', 0, 0, { props: { label: 'Apellido' } }),
      ...formField('fecha_nacimiento', 1, 0),
      // PostgreSQL fills it - shown only on a saved record.
      ...formField('creado_en', 2, 0, { bindings: { visible: { kind: 'formula', formula: '{{vars.record.mode}} != "create"' } } }),
      ...formField('creado_por', 2, 6, {}, { props: { readonly: true } }),
      ...formField('observacion', 3, 0)
    ]
    expect(formEditableColumns(fields, { sexo: { label: 'Sexo' }, observacion: { label: 'Observación' } })).toEqual([
      { column: 'apellido', label: 'Apellido' },
      { column: 'fecha_nacimiento', label: 'Fecha Nacimiento' },
      { column: 'sexo', label: 'Sexo' },
      { column: 'observacion', label: 'Observación' }
    ])
  })
})
