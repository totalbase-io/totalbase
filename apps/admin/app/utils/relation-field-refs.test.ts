import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { buildFieldsParam, collectRelationFieldRefs } from '~/utils/relation-field-refs'

const field = (kind: string, config: Record<string, unknown>) => ({ id: kind, kind, config }) as unknown as DataViewField

describe('collectRelationFieldRefs()', () => {
  it('reads a grid column\'s formulas, never its record page\'s widgets', () => {
    // Regression: a Kanban broke on its record page's widgets - their bindings are objects, not formulas.
    const fields = [
      field('COLUMN', { bindings: { visible: '{{customer.name}} != ""' } }),
      field('WIDGET', { bindings: { items: { kind: 'variable', variable: 'clientes' } } })
    ]
    expect(collectRelationFieldRefs(fields, ['{{status.name}}', null])).toEqual([
      { column: 'customer', relatedColumn: 'name' },
      { column: 'status', relatedColumn: 'name' }
    ])
  })
})

describe('buildFieldsParam()', () => {
  const column = (columnName: string, visible = true) => ({ id: columnName, kind: 'COLUMN', columnName, visible, config: {} }) as unknown as DataViewField

  it('reads only the DataView\'s columns - shown or hidden - and the primary key', () => {
    const fields = [column('name'), column('email', false), { id: 'w', kind: 'WIDGET', columnName: null, config: {} } as unknown as DataViewField]
    expect(buildFieldsParam(fields, 'id', [])).toBe('name,email,id')
  })

  it('adds the joins it needs', () => {
    expect(buildFieldsParam([column('customer')], 'id', [{ column: 'customer', relatedColumn: 'name' }], ['store.name'])).toBe('customer,id,customer.name,store.name')
  })

  it('asks for a path once when a related column and a foreign key\'s display are the same one', () => {
    const related = { ...column('brand.name'), kind: 'RELATED' as const }
    expect(buildFieldsParam([column('brand'), related], 'id', [{ column: 'brand', relatedColumn: 'name' }], ['brand.name'])).toBe('brand,brand.name,id')
  })
})
