import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { displayColumns, displayText, sortForViewer, sortKey } from '~/utils/display-field'

function column(columnName: string, config: Record<string, unknown> = {}): DataViewField {
  return { kind: 'COLUMN', columnName, config } as unknown as DataViewField
}

describe('sortKey()', () => {
  it('sorts a foreign key by the related column it shows', () => {
    expect(sortKey(column('brand', { display_field: 'name' }))).toBe('brand.name')
    expect(sortKey(column('name'))).toBe('name')
  })
  it('falls back to the key where the viewer may not read the related column', () => {
    expect(sortKey(column('brand', { display_field: 'name', display_field_denied: true }))).toBe('brand')
  })
})

describe('sortForViewer()', () => {
  it('turns entries on related columns the viewer may not read into their key, direction kept', () => {
    const fields = [column('brand', { display_field: 'name', display_field_denied: true }), column('status', { display_field: 'label' })]
    expect(sortForViewer('-brand.name,status.label,id', fields)).toBe('-brand,status.label,id')
    expect(sortForViewer('name', [column('name')])).toBe('name')
  })
})

describe('displayColumns() / displayText()', () => {
  const row: Record<string, unknown> = { name: 'Acme', country: 'AR', code: null }
  it('one column, or a template\'s columns in order', () => {
    expect(displayColumns({ display_field: 'name' })).toEqual(['name'])
    expect(displayColumns({ display_field: 'name', display_template: '{{name}} ({{country}}) - {{name}}' })).toEqual(['name', 'country'])
    expect(displayColumns({})).toEqual([])
  })
  it('fills the template, an empty value as empty - null with no related row', () => {
    expect(displayText({ display_field: 'name' }, c => row[c])).toBe('Acme')
    expect(displayText({ display_template: '{{name}} ({{country}})' }, c => row[c])).toBe('Acme (AR)')
    expect(displayText({ display_template: '{{name}} {{code}}' }, c => row[c])).toBe('Acme')
    expect(displayText({ display_template: '{{name}}' }, () => null)).toBeNull()
  })
  it('sorts a template by its first column', () => {
    expect(sortKey(column('brand', { display_field: 'name', display_template: '{{country}} - {{name}}' }))).toBe('brand.country')
  })
})
