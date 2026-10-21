import { describe, expect, it } from 'vitest'
import { foreignKeyDisplay, foreignKeySearch } from '~/utils/foreign-key-display'

// A foreign key picked by its row presentation (DataViews.md §4.4).
describe('foreignKeyDisplay()', () => {
  it('reads and searches its template\'s columns, else its display field, else its key', () => {
    const templated = foreignKeyDisplay({ config: { display_template: '{{codigo}} · {{nombre}}', display_field: 'codigo' } }, 'id')
    expect(templated.columns).toEqual(['codigo', 'nombre'])
    expect(templated.text({ id: 1, codigo: 'AGU-5', nombre: 'Kit agua' })).toBe('AGU-5 · Kit agua')
    expect(foreignKeySearch(templated, ' Kit ')).toEqual({ _or: [{ codigo: { _ilike: '%Kit%' } }, { nombre: { _ilike: '%Kit%' } }] })
    expect(foreignKeySearch(templated, '')).toBeNull()
    expect(foreignKeyDisplay({ config: { display_field: 'nombre' } }, 'id').text({ id: 1, nombre: 'Acme' })).toBe('Acme')
    expect(foreignKeyDisplay(undefined, 'id').text({ id: 7 })).toBe('7')
  })
})
