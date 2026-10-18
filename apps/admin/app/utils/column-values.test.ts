import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { columnValueSource } from './column-values'

const field = (columnName: string, config: Record<string, unknown> = {}, kind: DataViewField['kind'] = 'COLUMN') => ({ kind, columnName, config } as unknown as DataViewField)

describe('columnValueSource', () => {
  it('a foreign key shown by its table\'s presentation picks from that table\'s rows', () => {
    const target = { schema: 'public', table: 'tipos_documento', column: 'id' }
    expect(columnValueSource(field('tipo_documento', { display_field: 'descripcion', display_field_target: target }))).toEqual({
      kind: 'relation', ...target, display: { display_field: 'descripcion' }
    })
  })

  it('a foreign key the viewer may not see shown, or a related column, picks nothing', () => {
    const target = { schema: 'public', table: 'tipos_documento', column: 'id' }
    expect(columnValueSource(field('tipo_documento', { display_field: 'descripcion', display_field_target: target, display_field_denied: true }))).toBeUndefined()
    expect(columnValueSource(field('cliente.cuit', {}, 'RELATED'))).toBeUndefined()
  })

  it('a CHECK list picks from its values, labelled by the column\'s presentation', () => {
    expect(columnValueSource(field('status', { options: { OPEN: { label: 'Abierto' } } }), ['OPEN', 'CLOSED'])).toEqual({
      kind: 'list', items: [{ value: 'OPEN', label: 'Abierto' }, { value: 'CLOSED', label: 'CLOSED' }]
    })
    expect(columnValueSource(field('notes'))).toBeUndefined()
  })
})
