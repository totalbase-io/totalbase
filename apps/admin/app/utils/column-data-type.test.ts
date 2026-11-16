import { describe, expect, it } from 'vitest'
import { composeDataType, currentDataType, dataTypeParts } from './column-data-type'

describe('column data types', () => {
  it('splits a type into its parts and composes it back', () => {
    const numeric = { dataType: 'numeric(12,2)', typeName: 'numeric', typePrecision: 12, typeScale: 2 }
    expect(dataTypeParts(numeric)).toEqual({ base: 'numeric', length: undefined, precision: '12', scale: '2' })
    expect(currentDataType(numeric)).toBe('numeric(12,2)')
    expect(composeDataType({ base: 'varchar', length: '80' })).toBe('varchar(80)')
    expect(composeDataType({ base: 'text', length: '80' })).toBe('text')
  })

  it('keeps a domain as the type, without parts', () => {
    const domain = { dataType: 'text', typeName: 'text', domain: 'cuit' }
    expect(dataTypeParts(domain)).toEqual({ base: 'cuit' })
    expect(currentDataType(domain)).toBe('cuit')
  })
})
